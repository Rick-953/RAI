const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const https = require('https');  // 用于网页搜索
const packageInfo = require('./package.json');
const { runAgentPipeline, normalizeUsage } = require('./agent/engine');
const { signUserSessionToken, verifyUserSessionToken } = require('./user-session-token');

const app = express();
app.disable('x-powered-by');

function cleanEnvValue(value) {
    let text = String(value ?? '').trim();
    for (let i = 0; i < 2; i += 1) {
        if (
            (text.startsWith('"') && text.endsWith('"')) ||
            (text.startsWith("'") && text.endsWith("'"))
        ) {
            text = text.slice(1, -1).trim();
        }
    }
    return text;
}

function normalizeResendFromEmail(value) {
    const text = cleanEnvValue(value);
    if (!text || /[\r\n]/.test(text)) return '';

    const namedMatch = text.match(/^(.+?)\s*<([^<>]+)>$/);
    const displayName = namedMatch ? namedMatch[1].trim() : '';
    const email = (namedMatch ? namedMatch[2] : text).trim();
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) {
        return '';
    }

    return displayName ? `${displayName} <${email}>` : email;
}

// 安全默认：本地直连时不信任代理头。反向代理部署时可通过 TRUST_PROXY 显式开启。
const trustProxyEnv = cleanEnvValue(process.env.TRUST_PROXY);
let trustProxySetting = false;
if (trustProxyEnv) {
    if (trustProxyEnv === 'true') {
        trustProxySetting = 1;
    } else if (trustProxyEnv === 'false') {
        trustProxySetting = false;
    } else if (/^\d+$/.test(trustProxyEnv)) {
        trustProxySetting = parseInt(trustProxyEnv, 10);
    } else {
        trustProxySetting = trustProxyEnv;
    }
}
app.set('trust proxy', trustProxySetting);
const PORT = cleanEnvValue(process.env.PORT) || 3009;
const HOST = (cleanEnvValue(process.env.HOST) || cleanEnvValue(process.env.BIND_HOST) || '127.0.0.1').trim();
const IS_PRODUCTION = cleanEnvValue(process.env.NODE_ENV).toLowerCase() === 'production';
const PACKAGE_VERSION = packageInfo.version || '0.0.0';
const MAX_CONCURRENT_REQUESTS_PER_USER = Math.max(
    1,
    parseInt(cleanEnvValue(process.env.RAI_MAX_CONCURRENT_REQUESTS_PER_USER) || '2', 10) || 2
);
const ADMIN_TOKEN_EXPIRES_IN = cleanEnvValue(process.env.ADMIN_TOKEN_EXPIRES_IN) || (IS_PRODUCTION ? '12h' : '30d');
const ADMIN_TOTP_REQUIRED = parseBooleanEnv(process.env.RAI_ADMIN_TOTP_REQUIRED, IS_PRODUCTION);
const PASSWORD_MIN_LENGTH = 6;
const PASSWORD_MAX_LENGTH = 128;
const EMAIL_MAX_LENGTH = 255;
const USERNAME_MAX_LENGTH = 80;
const LONG_MEMORY_DEFAULT_ENABLED = parseBooleanEnv(process.env.RAI_LONG_MEMORY_DEFAULT_ENABLED, false);
const LONG_MEMORY_PROMPT_LIMIT = Math.max(1, parseInt(cleanEnvValue(process.env.RAI_LONG_MEMORY_PROMPT_LIMIT) || '24', 10) || 24);
const RECENT_TITLE_MEMORY_LIMIT = Math.max(1, parseInt(cleanEnvValue(process.env.RAI_RECENT_TITLE_MEMORY_LIMIT) || '10', 10) || 10);
const MEMORY_CONTEXT_MESSAGE_LIMIT = Math.max(2, Math.min(parseInt(cleanEnvValue(process.env.RAI_MEMORY_CONTEXT_MESSAGE_LIMIT) || '8', 10) || 8, 16));
const MEMORY_CONTENT_MAX_LENGTH = 360;
const MEMORY_KEY_MAX_LENGTH = 96;
const MEMORY_EXTRACTION_MODEL_ID = 'deepseek-flash';
const MEMORY_MODEL_MAX_TOKENS = 700;
const MEMORY_MODEL_TIMEOUT_MS = 15000;
const TITLE_FALLBACK_MODEL_IDS = ['chatgpt-gpt-oss-120b', 'deepseek-flash'];
const TITLE_FALLBACK_MAX_TOKENS = 80;
const TITLE_FALLBACK_TIMEOUT_MS = 10000;
const IMAGE_WAITING_LINE_MODEL_ID = 'deepseek-flash';
const IMAGE_WAITING_LINE_TIMEOUT_MS = 5000;
const CHAT_CLIENT_ALLOWED_ROLES = new Set(['user', 'assistant']);
const CHAT_CLIENT_MAX_MESSAGES = Math.max(2, Math.min(parseInt(cleanEnvValue(process.env.RAI_CHAT_CLIENT_MAX_MESSAGES) || '40', 10) || 40, 80));
const CHAT_CLIENT_MAX_MESSAGE_CHARS = Math.max(1000, Math.min(parseInt(cleanEnvValue(process.env.RAI_CHAT_CLIENT_MAX_MESSAGE_CHARS) || '24000', 10) || 24000, 60000));
const CHAT_CLIENT_MAX_TOTAL_CHARS = Math.max(CHAT_CLIENT_MAX_MESSAGE_CHARS, Math.min(parseInt(cleanEnvValue(process.env.RAI_CHAT_CLIENT_MAX_TOTAL_CHARS) || '140000', 10) || 140000, 240000));
const CHAT_CLIENT_MAX_ATTACHMENTS = Math.max(0, Math.min(parseInt(cleanEnvValue(process.env.RAI_CHAT_CLIENT_MAX_ATTACHMENTS) || '8', 10) || 8, 20));
const ATTACHMENT_UPLOAD_HARD_LIMIT_BYTES = 50 * 1024 * 1024;
const GENERIC_SESSION_TITLE_RE = /^(新对话|新 ChatFlow|临时对话|New Chat|Temporary chat|Untitled|未命名)$/i;
const MEMORY_CATEGORIES = new Set([
    'identity',
    'profile',
    'preference',
    'interest',
    'ability',
    'weakness',
    'health',
    'relationship',
    'work',
    'other'
]);

function validatePasswordLength(password, fieldLabel = '密码') {
    if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
        return `${fieldLabel}至少需要${PASSWORD_MIN_LENGTH}位`;
    }
    if (password.length > PASSWORD_MAX_LENGTH) {
        return `${fieldLabel}不能超过${PASSWORD_MAX_LENGTH}位`;
    }
    return '';
}

function normalizeUsernameForStorage(username) {
    const normalized = String(username || '').trim().replace(/\s+/g, ' ');
    if (!normalized) return { value: '' };
    if (normalized.length > USERNAME_MAX_LENGTH) {
        return { error: `用户名不能超过${USERNAME_MAX_LENGTH}个字符` };
    }
    if (/[<>]/.test(normalized) || /(?:style\s*=|on\w+\s*=|javascript:|<\/?[a-z][\s>/])/i.test(normalized)) {
        return { error: '用户名不能包含 HTML 或脚本内容' };
    }
    if (/[\u0000-\u001F\u007F]/.test(normalized)) {
        return { error: '用户名不能包含控制字符' };
    }
    if (!/^[\p{L}\p{N}][\p{L}\p{N}._\- ]{0,79}$/u.test(normalized)) {
        return { error: '用户名只能包含文字、数字、空格、点、下划线或连字符，且必须以文字或数字开头' };
    }
    return { value: normalized };
}

function buildDefaultUsernameFromEmail(email) {
    const localPart = String(email || '').split('@')[0] || 'User';
    const safe = localPart
        .replace(/[^\p{L}\p{N}._\- ]/gu, '_')
        .replace(/[_.\- ]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, USERNAME_MAX_LENGTH);
    const normalized = normalizeUsernameForStorage(safe);
    return normalized.value || 'User';
}

function normalizeEmailForAuth(email) {
    return String(email || '').trim().toLowerCase();
}

function isValidEmailForAuth(email) {
    const normalized = normalizeEmailForAuth(email);
    return normalized.length > 0
        && normalized.length <= EMAIL_MAX_LENGTH
        && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized);
}

function buildProviderUsername(provider, externalUid) {
    const providerPrefix = String(provider || 'user').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'user';
    const uidPart = String(externalUid || '').replace(/[^A-Za-z0-9_-]/g, '_').replace(/_+/g, '_').slice(0, 48) || crypto.randomBytes(4).toString('hex');
    return buildDefaultUsernameFromEmail(`${providerPrefix}_${uidPart}@local.invalid`);
}

function escapeEmailHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function generateEmailCode() {
    const length = crypto.randomInt(EMAIL_CODE_MIN_LENGTH, EMAIL_CODE_MAX_LENGTH + 1);
    let output = '';
    for (let i = 0; i < length; i += 1) {
        output += EMAIL_CODE_ALLOWED_CHARS[crypto.randomInt(0, EMAIL_CODE_ALLOWED_CHARS.length)];
    }
    return output;
}

function normalizeEmailCodeInput(code) {
    return String(code || '')
        .normalize('NFKC')
        .trim()
        .replace(/\s+/g, '')
        .slice(0, EMAIL_CODE_MAX_LENGTH + 8);
}

function isValidEmailCodeInput(code) {
    const normalized = normalizeEmailCodeInput(code);
    if (normalized.length < EMAIL_CODE_MIN_LENGTH || normalized.length > EMAIL_CODE_MAX_LENGTH) return false;
    return new RegExp(`^[${EMAIL_CODE_ALLOWED_CHARS.replace(/[\\\]\-^]/g, '\\$&')}]+$`).test(normalized);
}

function hashEmailCode({ email, purpose, code }) {
    const normalizedCode = normalizeEmailCodeInput(code);
    return crypto
        .createHmac('sha256', JWT_SECRET)
        .update(`${normalizeEmailForAuth(email)}:${String(purpose || '').trim()}:${normalizedCode}`)
        .digest('hex');
}

function requireSecretEnv(name, minLength = 32) {
    const value = cleanEnvValue(process.env[name]);
    if (value.length < minLength) {
        console.error(` 启动失败: ${name} 未配置或长度不足 ${minLength} 字符`);
        process.exit(1);
    }
    return value;
}

function parseBooleanEnv(value, defaultValue = false) {
    const normalized = cleanEnvValue(value).toLowerCase();
    if (!normalized) return defaultValue;
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return defaultValue;
}

function parseCsvEnv(value) {
    return cleanEnvValue(value)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
}

const JWT_SECRET = requireSecretEnv('JWT_SECRET', 32);
const OPENROUTER_BASE_URL = cleanEnvValue(process.env.OPENROUTER_BASE_URL) || 'https://openrouter.ai/api/v1/chat/completions';
const NEWAPI_BASE_URL = cleanEnvValue(process.env.NEWAPI_BASE_URL) || 'https://api.18363221.xyz/v1/chat/completions';
const GOOGLE_GEMINI_BASE_URL = cleanEnvValue(process.env.GOOGLE_GEMINI_BASE_URL) || 'https://generativelanguage.googleapis.com/v1beta/models';
const ZTX6D_APP_ID = cleanEnvValue(process.env.ZTX6D_APP_ID);
const ZTX6D_APP_KEY = cleanEnvValue(process.env.ZTX6D_APP_KEY);
const ZTX6D_API_URL = cleanEnvValue(process.env.ZTX6D_API_URL) || 'https://ztx6d.cn/open.php';
const ZTX6D_LOGIN_URL = cleanEnvValue(process.env.ZTX6D_LOGIN_URL) || 'https://ztx6d.cn/';
const ZTX6D_CALLBACK_URL = cleanEnvValue(process.env.ZTX6D_CALLBACK_URL);
const ZTX6D_FORCE_DISABLED = parseBooleanEnv(process.env.ZTX6D_FORCE_DISABLED || process.env.RAI_ZTX6D_FORCE_DISABLED, false);
const PUBLIC_BASE_URL = cleanEnvValue(process.env.PUBLIC_BASE_URL);
const BRAND_NAME = cleanEnvValue(process.env.RAI_BRAND_NAME) || 'RAI';
const BRAND_SHORT_NAME = cleanEnvValue(process.env.RAI_BRAND_SHORT_NAME) || BRAND_NAME;
const BRAND_BADGE = cleanEnvValue(process.env.RAI_BRAND_BADGE);
const BRAND_TITLE = cleanEnvValue(process.env.RAI_BRAND_TITLE) || [BRAND_NAME, BRAND_BADGE].filter(Boolean).join(' ') || BRAND_NAME;
const OPENROUTER_HTTP_REFERER = cleanEnvValue(process.env.OPENROUTER_HTTP_REFERER) || PUBLIC_BASE_URL || 'https://rai.rick.sarl';
const OPENROUTER_APP_TITLE = cleanEnvValue(process.env.OPENROUTER_APP_TITLE) || BRAND_TITLE || 'RAI';
const DEFAULT_DOMAIN_NOTICE_ENABLED = parseBooleanEnv(process.env.RAI_DEFAULT_DOMAIN_NOTICE_ENABLED, true);
const DEFAULT_DOMAIN_NOTICE_URL = cleanEnvValue(process.env.RAI_DEFAULT_DOMAIN_NOTICE_URL) || 'https://rai.rick.sarl/';
const DEFAULT_DISABLED_MODEL_IDS_RAW = parseCsvEnv(process.env.RAI_DEFAULT_DISABLED_MODELS);
const CSP_ALLOW_LOCAL_CONNECT = parseBooleanEnv(process.env.RAI_CSP_ALLOW_LOCAL_CONNECT, false);
const CSP_STRICT_SCRIPT_SRC = parseBooleanEnv(process.env.RAI_CSP_STRICT_SCRIPT_SRC, false);
const ADMIN_USERNAME = cleanEnvValue(process.env.ADMIN_USERNAME) || 'admin';
const ADMIN_PASSWORD_HASH = requireSecretEnv('ADMIN_PASSWORD_HASH', 50);
const ADMIN_JWT_SECRET = requireSecretEnv('ADMIN_JWT_SECRET', 32);
const ADMIN_TOTP_SECRET = cleanEnvValue(process.env.ADMIN_TOTP_SECRET).replace(/[\s=:-]/g, '').toUpperCase();
const TOTP_ISSUER = cleanEnvValue(process.env.RAI_TOTP_ISSUER) || BRAND_TITLE || 'RAI';
const ZTX6D_RT_TTL_MS = 10 * 60 * 1000;
const ZTX6D_AUTH_CODE_TTL_MS = 2 * 60 * 1000;
const TWO_FACTOR_SETUP_TTL = '10m';
const TWO_FACTOR_LOGIN_TTL = '5m';
const RESEND_API_KEY = cleanEnvValue(process.env.RESEND_API_KEY || process.env.RAI_RESEND_API_KEY);
const RESEND_API_URL = cleanEnvValue(process.env.RESEND_API_URL) || 'https://api.resend.com/emails';
const RESEND_FROM_EMAIL_RAW = cleanEnvValue(process.env.RESEND_FROM_EMAIL || process.env.RAI_EMAIL_FROM) || 'onboarding@resend.dev';
const RESEND_FROM_EMAIL = normalizeResendFromEmail(RESEND_FROM_EMAIL_RAW);
if (!RESEND_FROM_EMAIL) {
    console.warn(' RESEND_FROM_EMAIL/RAI_EMAIL_FROM 格式无效，应为 email@example.com 或 Name <email@example.com>');
}
const RESEND_TIMEOUT_MS = Math.max(
    3000,
    parseInt(cleanEnvValue(process.env.RAI_RESEND_TIMEOUT_MS) || '12000', 10) || 12000
);
const ALLOW_RESEND_TEST_MODE_EMAIL_BYPASS = parseBooleanEnv(process.env.RAI_ALLOW_RESEND_TEST_MODE_EMAIL_BYPASS, false);
const EMAIL_CODE_TTL_MS = Math.max(
    60 * 1000,
    parseInt(cleanEnvValue(process.env.RAI_EMAIL_CODE_TTL_SECONDS) || '600', 10) * 1000 || 10 * 60 * 1000
);
const EMAIL_CODE_MAX_ATTEMPTS = Math.max(
    3,
    parseInt(cleanEnvValue(process.env.RAI_EMAIL_CODE_MAX_ATTEMPTS) || '6', 10) || 6
);
const EMAIL_CODE_PURPOSES = new Set(['register', 'login', 'password_reset']);
const EMAIL_CODE_MIN_LENGTH = Math.max(10, parseInt(cleanEnvValue(process.env.RAI_EMAIL_CODE_MIN_LENGTH) || '10', 10) || 10);
const EMAIL_CODE_MAX_LENGTH = Math.max(
    EMAIL_CODE_MIN_LENGTH,
    Math.min(32, parseInt(cleanEnvValue(process.env.RAI_EMAIL_CODE_MAX_LENGTH) || '16', 10) || 16)
);
const EMAIL_CODE_ALLOWED_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*_-+=?';
const ENV_API_KEYS = {
    TAVILY_API_KEY: cleanEnvValue(process.env.TAVILY_API_KEY),
    ALIYUN_API_KEY: cleanEnvValue(process.env.ALIYUN_API_KEY),
    DEEPSEEK_API_KEY: cleanEnvValue(process.env.DEEPSEEK_API_KEY),
    SILICONFLOW_API_KEY: cleanEnvValue(process.env.SILICONFLOW_API_KEY),
    GOOGLE_GEMINI_API_KEY: cleanEnvValue(process.env.GOOGLE_GEMINI_API_KEY),
    OPENROUTER_API_KEY: cleanEnvValue(process.env.OPENROUTER_API_KEY),
    NEWAPI_API_KEY: cleanEnvValue(process.env.NEWAPI_API_KEY)
};

const RAI_RUNTIME_REPORT_PATH = path.resolve(cleanEnvValue(process.env.RAI_RUNTIME_REPORT_PATH) || path.join(__dirname, 'rai运行报告.md'));
const RAI_RUNTIME_REPORT_CONTACT = 'rick080402@gmail.com';

function buildProviderFetchHeaders(providerConfig, providerName = '') {
    const headers = {
        'Authorization': `Bearer ${providerConfig.apiKey}`,
        'Content-Type': 'application/json'
    };
    if (providerName === 'openrouter') {
        headers['HTTP-Referer'] = OPENROUTER_HTTP_REFERER;
        headers['X-Title'] = OPENROUTER_APP_TITLE;
    }
    return headers;
}

function buildGeneratedImageMarkdown(result = {}) {
    const images = Array.isArray(result?.images) ? result.images : [];
    return images
        .map((image, index) => {
            const url = String(image?.url || '').trim();
            if (!url || !url.startsWith(GENERATED_IMAGE_PUBLIC_PREFIX + '/')) return '';
            return `![生成图片 ${index + 1}](${url})`;
        })
        .filter(Boolean)
        .join('\n\n');
}

function maskReportString(value) {
    let text = String(value || '');
    text = text.replace(/https:\/\/s3\.siliconflow\.cn\/temporary\/[^\s"']+/g, '[siliconflow_generated_image_url]');
    text = text.replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=_-]{80,}/g, '[generated_image_base64]');
    text = text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer [redacted]');
    text = text.replace(/\bsk-[A-Za-z0-9._~+/=-]{12,}\b/g, '[redacted_api_key]');
    text = text.replace(/\bsk-or-[A-Za-z0-9._~+/=-]{12,}\b/g, '[redacted_api_key]');
    text = text.replace(/\bre_[A-Za-z0-9._~+/=-]{12,}\b/g, '[redacted_resend_key]');
    text = text.replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, '[redacted_google_key]');
    if (text.length > 1600) text = `${text.slice(0, 1600)}...`;
    return text;
}

function sanitizeReportContext(value, depth = 0) {
    if (depth > 4) return '[truncated]';
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return maskReportString(value);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeReportContext(item, depth + 1));
    if (typeof value === 'object') {
        const output = {};
        for (const [key, item] of Object.entries(value).slice(0, 40)) {
            if (/key|token|secret|password|authorization/i.test(key)) {
                output[key] = '[redacted]';
            } else {
                output[key] = sanitizeReportContext(item, depth + 1);
            }
        }
        return output;
    }
    return maskReportString(String(value));
}

function appendRaiRuntimeReport(entry = {}) {
    const level = maskReportString(entry.level || '报错');
    const tag = maskReportString(entry.tag || 'runtime');
    const message = maskReportString(entry.message || '');
    const context = sanitizeReportContext(entry.context || {});
    const block = [
        '',
        `## ${new Date().toISOString()} ${level} ${tag}`,
        message ? `- message: ${message}` : '- message: (empty)',
        '- context:',
        '```json',
        JSON.stringify(context, null, 2),
        '```',
        ''
    ].join('\n');

    fs.promises.mkdir(path.dirname(RAI_RUNTIME_REPORT_PATH), { recursive: true })
        .then(() => fs.promises.appendFile(RAI_RUNTIME_REPORT_PATH, block, 'utf8'))
        .catch((error) => console.warn(' 写入 RAI 运行报告失败:', error.message));
}

function buildUserFacingApiFailureMessage() {
    return `AI 服务暂时不可用，RAI 已记录报错并尝试备用线路；如果仍失败，请联系 ${RAI_RUNTIME_REPORT_CONTACT}。`;
}

const KOLORS_IMAGE_MODEL = 'Kwai-Kolors/Kolors';
const SILICONFLOW_IMAGE_GENERATION_URL = cleanEnvValue(process.env.SILICONFLOW_IMAGE_GENERATION_URL) || 'https://api.siliconflow.cn/v1/images/generations';
const KOLORS_IMAGE_SIZES = ['1024x1024', '960x1280', '768x1024', '720x1440', '720x1280'];
const GENERATED_IMAGES_DIR = path.join(__dirname, 'uploads', 'generated-images');
const GENERATED_IMAGE_PUBLIC_PREFIX = '/generated-images';
const MAX_GENERATED_IMAGE_BYTES = Math.max(
    1024 * 1024,
    parseInt(cleanEnvValue(process.env.RAI_GENERATED_IMAGE_MAX_BYTES) || String(20 * 1024 * 1024), 10) || 20 * 1024 * 1024
);
const GENERATED_IMAGE_FETCH_TIMEOUT_MS = Math.max(
    1000,
    parseInt(cleanEnvValue(process.env.RAI_GENERATED_IMAGE_FETCH_TIMEOUT_MS) || '8000', 10) || 8000
);
const IMAGE_URL_HEAD_TIMEOUT_MS = Math.max(
    500,
    parseInt(cleanEnvValue(process.env.RAI_IMAGE_URL_HEAD_TIMEOUT_MS) || '2000', 10) || 2000
);
const SAFE_IMAGE_FETCH_MAX_REDIRECTS = Math.max(
    0,
    Math.min(5, parseInt(cleanEnvValue(process.env.RAI_IMAGE_FETCH_MAX_REDIRECTS) || '3', 10) || 3)
);
const GENERATED_IMAGE_ALLOWED_SOURCE_HOSTS = new Set(
    parseCsvEnv(process.env.RAI_GENERATED_IMAGE_ALLOWED_HOSTS || 'siliconflow.cn')
        .map((host) => normalizeHostname(host))
        .filter(Boolean)
);

const TOTP_BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function normalizeTotpSecret(secret) {
    return String(secret || '').replace(/[\s=:-]/g, '').toUpperCase();
}

function generateTotpSecret(byteLength = 20) {
    const bytes = crypto.randomBytes(byteLength);
    let bits = '';
    for (const byte of bytes) {
        bits += byte.toString(2).padStart(8, '0');
    }

    let output = '';
    for (let i = 0; i < bits.length; i += 5) {
        const chunk = bits.slice(i, i + 5).padEnd(5, '0');
        output += TOTP_BASE32_ALPHABET[parseInt(chunk, 2)];
    }
    return output;
}

function decodeBase32Secret(secret) {
    const normalized = normalizeTotpSecret(secret);
    if (!normalized || /[^A-Z2-7]/.test(normalized)) {
        throw new Error('invalid_totp_secret');
    }

    let bits = '';
    for (const char of normalized) {
        const value = TOTP_BASE32_ALPHABET.indexOf(char);
        if (value < 0) throw new Error('invalid_totp_secret');
        bits += value.toString(2).padStart(5, '0');
    }

    const bytes = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) {
        bytes.push(parseInt(bits.slice(i, i + 8), 2));
    }
    return Buffer.from(bytes);
}

function safeCompareText(a, b) {
    const left = Buffer.from(String(a || ''));
    const right = Buffer.from(String(b || ''));
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function generateHotpCode(secret, counter, digits = 6) {
    const key = decodeBase32Secret(secret);
    const buffer = Buffer.alloc(8);
    const safeCounter = Math.max(0, Math.floor(Number(counter) || 0));
    buffer.writeUInt32BE(Math.floor(safeCounter / 0x100000000), 0);
    buffer.writeUInt32BE(safeCounter >>> 0, 4);

    const hmac = crypto.createHmac('sha1', key).update(buffer).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const binary = ((hmac[offset] & 0x7f) << 24)
        | ((hmac[offset + 1] & 0xff) << 16)
        | ((hmac[offset + 2] & 0xff) << 8)
        | (hmac[offset + 3] & 0xff);
    return String(binary % (10 ** digits)).padStart(digits, '0');
}

function normalizeTotpCodeInput(code) {
    return String(code || '')
        .normalize('NFKC')
        .replace(/[^\d]/g, '')
        .slice(0, 12);
}

function verifyTotpCode(secret, code, options = {}) {
    const normalizedCode = normalizeTotpCodeInput(code);
    if (!/^\d{6}$/.test(normalizedCode)) return false;

    const windowSize = Number.isInteger(options.window) ? Math.max(0, options.window) : 2;
    const period = Number.isInteger(options.period) ? Math.max(15, options.period) : 30;
    const currentCounter = Math.floor(Date.now() / 1000 / period);
    const normalizedSecret = normalizeTotpSecret(secret);
    if (!normalizedSecret) return false;

    try {
        for (let offset = -windowSize; offset <= windowSize; offset += 1) {
            const candidate = generateHotpCode(normalizedSecret, currentCounter + offset);
            if (safeCompareText(candidate, normalizedCode)) {
                if (offset !== 0) {
                    console.warn(` TOTP 验证通过但存在时间漂移: offset=${offset}, period=${period}s`);
                }
                return true;
            }
        }
    } catch (error) {
        console.warn(' TOTP 校验失败:', error.message);
    }
    return false;
}

function buildOtpAuthUrl({ issuer = TOTP_ISSUER, accountName = '', secret }) {
    const normalizedSecret = normalizeTotpSecret(secret);
    const safeIssuer = String(issuer || 'RAI').trim() || 'RAI';
    const safeAccount = String(accountName || 'user').trim() || 'user';
    const label = `${encodeURIComponent(safeIssuer)}:${encodeURIComponent(safeAccount)}`;
    const params = new URLSearchParams({
        secret: normalizedSecret,
        issuer: safeIssuer,
        algorithm: 'SHA1',
        digits: '6',
        period: '30'
    });
    return `otpauth://totp/${label}?${params.toString()}`;
}

function buildUserTwoFactorSetupToken(user, setupId) {
    return jwt.sign(
        { type: 'user_2fa_setup', userId: user.id, email: user.email, setupId: String(setupId || '') },
        JWT_SECRET,
        { expiresIn: TWO_FACTOR_SETUP_TTL }
    );
}

function buildUserTwoFactorSetupId() {
    return crypto.randomBytes(24).toString('base64url');
}

async function cleanupUserTwoFactorSetupChallenges() {
    const now = Date.now();
    const consumedBefore = now - (24 * 60 * 60 * 1000);
    await dbRunAsync(
        'DELETE FROM user_two_factor_setup_challenges WHERE expires_at < ? OR (consumed_at IS NOT NULL AND consumed_at < ?)',
        [now, consumedBefore]
    ).catch((error) => {
        console.warn(' 二步验证设置挑战清理失败:', error.message);
    });
}

async function createUserTwoFactorSetupChallenge(user, secret) {
    const setupId = buildUserTwoFactorSetupId();
    const now = Date.now();
    const expiresAt = now + 10 * 60 * 1000;
    await cleanupUserTwoFactorSetupChallenges();
    await dbRunAsync(
        `UPDATE user_two_factor_setup_challenges
         SET consumed_at = ?
         WHERE user_id = ? AND consumed_at IS NULL`,
        [now, user.id]
    );
    await dbRunAsync(
        `INSERT INTO user_two_factor_setup_challenges
         (setup_id, user_id, secret, created_at, expires_at, consumed_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
        [setupId, user.id, normalizeTotpSecret(secret), now, expiresAt]
    );
    return { setupId, expiresAt };
}

async function consumeUserTwoFactorSetupChallenge({ setupId, userId }) {
    const safeSetupId = String(setupId || '').trim();
    const numericUserId = Number(userId);
    if (!/^[A-Za-z0-9_-]{24,128}$/.test(safeSetupId) || !Number.isInteger(numericUserId) || numericUserId <= 0) {
        return null;
    }

    await dbRunAsync('BEGIN IMMEDIATE TRANSACTION');
    try {
        const row = await dbGetAsync(
            `SELECT *
             FROM user_two_factor_setup_challenges
             WHERE setup_id = ? AND user_id = ?`,
            [safeSetupId, numericUserId]
        );
        if (!row || row.consumed_at || Number(row.expires_at || 0) <= Date.now()) {
            await dbRunAsync('COMMIT');
            return null;
        }
        const result = await dbRunAsync(
            `UPDATE user_two_factor_setup_challenges
             SET consumed_at = ?
             WHERE setup_id = ? AND consumed_at IS NULL`,
            [Date.now(), safeSetupId]
        );
        if (Number(result?.changes || 0) !== 1) {
            await dbRunAsync('ROLLBACK');
            return null;
        }
        await dbRunAsync('COMMIT');
        return row;
    } catch (error) {
        await dbRunAsync('ROLLBACK').catch(() => null);
        throw error;
    }
}

function buildUserLoginTwoFactorToken(user) {
    return jwt.sign(
        { type: 'user_login_2fa', userId: user.id, email: user.email },
        JWT_SECRET,
        { expiresIn: TWO_FACTOR_LOGIN_TTL }
    );
}

const ADMIN_MODEL_CATALOG = [
    { id: 'deepseek-flash', name: 'DeepSeek Flash / 极速模型', group: '快捷与全部模型' },
    { id: 'deepseek-pro', name: 'DeepSeek Pro / 专家模型', group: '快捷与全部模型' },
    { id: 'qwen3.6-35b-a3b', name: 'Qwen 3.6 35B / 多模态', group: '全部模型' },
    { id: 'kimi-k2.6', name: 'Kimi K2.6', group: '全部模型' },
    { id: 'chatgpt-gpt-oss-120b', name: 'ChatGPT', group: '全部模型' },
    { id: 'north-mini-code', name: 'Mimo Code', group: '全部模型' },
    { id: 'nemotron-3-ultra', name: 'Nemotron 3 Ultra', group: '全部模型' },
    { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6', group: 'MAX 模型' },
    { id: 'anthropic/claude-3-haiku', name: 'Claude 3 Haiku', group: 'MAX 模型' },
    { id: 'gemma', name: 'Gemma', group: '全部模型' }
];

const PUBLIC_MODEL_IDS = ADMIN_MODEL_CATALOG.map((model) => model.id);
const DEFAULT_DISABLED_MODEL_IDS = DEFAULT_DISABLED_MODEL_IDS_RAW.filter((modelId) => PUBLIC_MODEL_IDS.includes(modelId));
const AUTO_MODEL_PREFERENCE = ['deepseek-pro', 'deepseek-flash', 'chatgpt-gpt-oss-120b', 'gemma', 'north-mini-code', 'nemotron-3-ultra', 'qwen3.6-35b-a3b', 'kimi-k2.6'];
const AUTO_MULTIMODAL_MODEL_PREFERENCE = ['qwen3.6-35b-a3b', 'kimi-k2.6', 'gemini-3-flash', 'anthropic/claude-3-haiku'];
const MODEL_DISABLED_CACHE_TTL_MS = 10 * 1000;
let modelAvailabilityCache = { loadedAt: 0, disabled: new Set() };

function getDefaultDomainNoticeSeed() {
    if (!DEFAULT_DOMAIN_NOTICE_ENABLED || !DEFAULT_DOMAIN_NOTICE_URL) return null;
    return {
        titleZh: `${BRAND_NAME} 域名即将更换`,
        bodyZh: `${BRAND_NAME} 即将迁移到新域名 ${DEFAULT_DOMAIN_NOTICE_URL}。旧域名会在切换期间继续保留一段时间，请优先收藏新地址。`,
        titleEn: `${BRAND_NAME} domain is changing soon`,
        bodyEn: `${BRAND_NAME} is moving to ${DEFAULT_DOMAIN_NOTICE_URL}. The old domain will stay available during the transition, but please bookmark the new address first.`
    };
}

function isManagedDefaultDomainNotice(row = {}) {
    const title = String(row.title || '').trim();
    const body = String(row.body || '').trim();
    const expectedTitle = `${BRAND_NAME} 域名即将更换`;
    const prefix = `${BRAND_NAME} 即将迁移到新域名 `;
    const suffix = '。旧域名会在切换期间继续保留一段时间，请优先收藏新地址。';
    if (title !== expectedTitle || !body.startsWith(prefix) || !body.endsWith(suffix)) return false;
    const candidateUrl = body.slice(prefix.length, body.length - suffix.length).trim();
    try {
        const parsed = new URL(candidateUrl);
        return parsed.protocol === 'https:' || parsed.protocol === 'http:';
    } catch (error) {
        return false;
    }
}

function buildRuntimeConfigPayload() {
    return {
        brandName: BRAND_NAME,
        brandShortName: BRAND_SHORT_NAME,
        brandBadge: BRAND_BADGE,
        brandTitle: BRAND_TITLE,
        publicBaseUrl: PUBLIC_BASE_URL,
        defaultDomainNoticeEnabled: !!(DEFAULT_DOMAIN_NOTICE_ENABLED && DEFAULT_DOMAIN_NOTICE_URL),
        defaultDomainNoticeUrl: DEFAULT_DOMAIN_NOTICE_URL || ''
    };
}

// ==================== 智能路由引擎核心 v4 ====================

// 默认词库 (大幅扩充)
const defaultKeywords = {
    forceMax: [
        // 中文情绪词
        '不满意', '很生气', '生气', '愤怒', '错误', '有问题', '我生气了', '你们真烦', '别烦我',
        '糟糕', '太烂', '好烂', '太垃圾', '好垃圾', '好差劲', '太差劲', '好废物', '太废物',
        '坑爹', '气死', '郁闷', '烦死', '吐槽', '无语', '崩溃', '爆炸', '瞎说', '胡说', '乱说',
        '不对', '不是这样', '智障', '弱智', '傻逼', '滚', '闭嘴', '垃圾', '废物',
        // 标点符号
        '!', '!!', '!!!', '！！！！', '!!!!!', '!!!!!!', '……', '。。。', '…………', '！', '！！', '！！！',
        // 中文态度词
        '仔细', '认真', '详细', '一定要', '必须', '立即', '马上', '紧急', '重要', '关键', '严肃',
        '认真对待', '不能马虎', '务必', '千万', '绝对', '一定', '不许', '不能',
        // 英文情绪词
        'angry', 'furious', 'upset', 'disappointed', 'unsatisfied', 'awful', 'terrible', 'horrible',
        'wrong', 'error', 'problem', 'issue', 'urgent', 'critical', 'important', 'immediate',
        'cannot', 'must not', 'absolutely', 'definitely', 'certainly', 'seriously', 'carefully',
        'bad', 'stop', 'lie', 'lying', 'incorrect', 'false', 'stupid', 'idiot', 'shut up'
    ],
    complexity: [
        // 中文复杂值词
        '详细设计', '完整方案', '深层分析', '系统性', '多角度', '综合分析', '全面讨论', '深入探讨',
        '架构设计', '方案设计', '性能优化', '功能扩展', '集成方案', '解决方案', '最佳实践',
        '技术评估', '效果评测', '对比分析', '趋势预测', '风险评估', '成本分析',
        // 英文复杂值词
        'comprehensive', 'detailed', 'complete', 'thorough', 'systematic', 'analysis', 'design',
        'architecture', 'optimization', 'performance', 'integration', 'solution', 'strategy',
        'evaluation', 'assessment', 'comparison', 'prediction', 'forecast', 'complex'
    ],
    professional: [
        // 编程相关
        '算法', '数据结构', '微服务', '分布式', '并发', '异步', '线程', '进程', '进程间通信',
        '设计模式', '架构', '系统架构', '数据库', '缓存', '优化', '性能优化',
        '编程语言', '开发框架', '库', 'SDK', '依赖', '包管理', '版本控制',

        // 容器和云
        'Docker', 'Kubernetes', 'K8s', '容器化', '容器编排', 'AWS', 'Azure', 'GCP', '云计算',
        'Redis', 'MongoDB', 'MySQL', '消息队列', 'MQ', 'RabbitMQ', 'Kafka', 'ElasticSearch',

        // 测试和质量
        '单元测试', '集成测试', '测试覆盖率', 'Mock', '测试驱动', 'TDD', 'BDD',

        // 监控和运维
        '日志', '监控', '告警', '追踪', 'APM', '健康检查', '熔断', '限流', '隔离',

        // API和通信
        'API', 'REST', 'GraphQL', 'gRPC', 'HTTP', 'TCP', 'UDP', 'WebSocket', 'DNS',

        // 安全相关
        '加密', '密码学', 'SSL', 'TLS', '认证', '授权', '权限', '安全', '漏洞',

        // 数据相关
        '数据分析', '机器学习', '深度学习', '神经网络', '模型', 'NLP', 'CV',
        '爬虫', '大数据', 'Hadoop', 'Spark', 'Flink', 'ETL', '数据仓库',

        // 其他技术
        '物联网', 'IoT', '区块链', '智能合约', '虚拟机', '编译器', '解释器',
        '词法分析', '语法分析', '代码生成', '类型系统', '类型推断',

        // 工程化
        'CI/CD', 'DevOps', 'Git', 'GitLab', 'GitHub', '版本管理', '代码审查',
        'RESTful', '接口设计', '微前端', '前端工程', '后端工程',

        // 英文专业词
        'algorithm', 'datastructure', 'microservice', 'distributed', 'concurrent',
        'architecture', 'optimization', 'framework', 'pattern', 'container',
        'orchestration', 'scalability', 'availability', 'reliability', 'consistency',
        'deployment', 'integration', 'regression', 'refactoring', 'caching'
    ],
    math: [
        // 中文数学词
        '微分', '积分', '求导', '矩阵', '向量', '特征值', '特征向量', '行列式', '秩',
        '线性代数', '群论', '拓扑', '几何', '解析几何', '射影几何', '微分几何',
        '概率', '统计', '分布', '期望', '方差', '协方差', '相关系数', '回归',
        '傅里叶', '拉普拉斯', '卷积', '变换', '滤波', '频域', '时域',
        '微分方程', '偏微分方程', '常微分方程', '积分方程', '泛函分析',
        '数论', '组合', '排列', '阶乘', '二项式', '生成函数', '递推关系',
        '极限', '连续', '可导', '收敛', '发散', '级数', '泰勒级数', '傅里叶级数',
        '复数', '虚数', '实部', '虚部', '模', '辐角', '欧拉公式',
        '图论', '树', '图', '最短路径', '最大流', 'NP完全', '计算复杂度',

        // 英文数学词
        'derivative', 'integral', 'matrix', 'vector', 'eigenvalue', 'eigenvector',
        'linear algebra', 'probability', 'statistics', 'distribution', 'variance',
        'fourier', 'laplace', 'convolution', 'transform', 'differential',
        'equation', 'partial', 'limit', 'convergence', 'divergence', 'series',
        'complex', 'imaginary', 'eigenspace', 'determinant', 'rank'
    ]
};

// 路由配置
const config = {
    thresholds: { t1: 0.40, t2: 0.80 },
    weights: {
        inputLength: 0.15,
        codeDetection: 0.30,
        mathFormula: 0.25,
        reasoning: 0.25,
        languageMix: 0.05
    },
    professional: {
        threshold: 1,      // 触发Plus的阈值
        maxThreshold: 2    // 触发Max的阈值
    }
};

// 代码检测模式 (自动识别编程语言和代码特征)
const codePatterns = {
    languages: /\b(c|cpp|c\+\+|java|javascript|js|python|py|go|golang|rust|ruby|php|c#|csharp|typescript|ts|kotlin|swift|scala|r|matlab|perl|lua|groovy|clojure|haskell|elixir|erlang|julia|racket|scheme)\b/gi,
    codeMarkers: /```|function|def\s|class\s|async\s|await\s|import\s|require\(|from\s|module\.exports|export\s|=>|::|->|#include|\.filter|\.map|\.reduce/gi,
    comments: /\/\/|\/\*|\*\/|#\s|--|`/gi,
    htmlTags: /<(!DOCTYPE|html|head|body|div|span|class|style|script|meta|link|title|form|input|button|p|h[1-6]|ul|li|table|tr|td)\b/gi,
    brackets: /[\{\}\[\]\(\)<>]/g,
    sqlKeywords: /\b(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|FROM|WHERE|JOIN|GROUP\s+BY|ORDER\s+BY|LIMIT|ON|AS|UNION|VALUES)\b/gi
};

// ========== 关键词检测引擎 ==========
function detectKeywords(message) {
    const result = {
        forceMax: [],
        complexity: { count: 0, keywords: [] },
        professional: { count: 0, keywords: [] },
        math: { count: 0, keywords: [] },
        code: { detected: false, types: [] }
    };

    // 检测强制Max词
    defaultKeywords.forceMax.forEach(keyword => {
        if (message.toLowerCase().includes(keyword.toLowerCase())) {
            result.forceMax.push(keyword);
        }
    });

    // 检测复杂值词 (每个+0.12分)
    defaultKeywords.complexity.forEach(keyword => {
        if (message.toLowerCase().includes(keyword.toLowerCase())) {
            result.complexity.keywords.push(keyword);
            result.complexity.count++;
        }
    });

    // 检测专业词汇
    defaultKeywords.professional.forEach(keyword => {
        if (message.toLowerCase().includes(keyword.toLowerCase())) {
            result.professional.keywords.push(keyword);
            result.professional.count++;
        }
    });

    // 检测数学词汇
    defaultKeywords.math.forEach(keyword => {
        if (message.toLowerCase().includes(keyword.toLowerCase())) {
            result.math.keywords.push(keyword);
            result.math.count++;
        }
    });

    // 自动识别代码特征
    if (codePatterns.languages.test(message)) result.code.types.push('编程语言');
    if (codePatterns.codeMarkers.test(message)) result.code.types.push('代码标记');
    if (codePatterns.comments.test(message)) result.code.types.push('注释');
    if (codePatterns.htmlTags.test(message)) result.code.types.push('HTML');
    if ((message.match(codePatterns.brackets) || []).length > 3) result.code.types.push('括号结构');
    if (codePatterns.sqlKeywords.test(message)) result.code.types.push('SQL');

    result.code.detected = result.code.types.length > 0;
    return result;
}

// ========== 五维度复杂度评估 ==========
function evaluateComplexity(message) {
    const dimensions = {};
    const keywords = detectKeywords(message);

    // 维度1: 输入长度 (0.05-1.0)
    const len = message.length;
    dimensions.inputLength = len <= 15 ? 0.05 :
        len <= 30 ? 0.10 :
            len <= 60 ? 0.20 :
                len <= 150 ? 0.35 :
                    len <= 300 ? 0.50 :
                        Math.min(0.70 + (len - 300) / 1000, 0.9);

    // 维度2: 代码检测 (0-1.0)
    let codeScore = keywords.code.detected ? 0.3 + (keywords.code.types.length * 0.15) : 0;
    dimensions.codeDetection = Math.min(codeScore, 1);

    // 维度3: 数学词汇 (0-1.0)
    dimensions.mathFormula = Math.min(keywords.math.count * 0.15, 1);

    // 维度4: 推理复杂度 (0-1.0)
    const reasoningKeywords = ['为什么', '如何', '解释', '分析', '推理', '证明', 'why', 'how', 'explain'];
    let reasoningScore = reasoningKeywords.reduce((sum, word) =>
        sum + (message.toLowerCase().includes(word) ? 0.20 : 0), 0);
    reasoningScore += Math.min((message.match(/[。，！？,]/g) || []).length * 0.08, 0.15);
    dimensions.reasoning = Math.min(reasoningScore, 1);

    // 维度5: 语言混合度 (0-0.5)
    const mixCount = [/[\u4e00-\u9fa5]/.test(message), /[a-zA-Z]/.test(message),
    /[0-9]/.test(message), /[!@#$%^&*()_+={}\[\]:;"'<>,.?/\\|`~]/.test(message)]
        .filter(Boolean).length;
    dimensions.languageMix = Math.min((mixCount - 1) * 0.15, 0.5);

    // 计算加权基础分数
    let totalScore = Object.entries(config.weights).reduce((sum, [key, weight]) =>
        sum + (dimensions[key] * weight), 0);

    // 特殊加分项
    totalScore += keywords.complexity.count * 0.12; // 复杂值词
    totalScore += keywords.professional.count * 0.15; // 专业词汇

    return {
        score: Math.min(totalScore, 1),
        dimensions,
        keywords
    };
}

// ========== 路由决策引擎 ==========


// ========== 核心API接口 ==========


// ==================== 网页搜索功能 (Tavily API) ====================

// Tavily API 配置
const TAVILY_API_KEY = ENV_API_KEYS.TAVILY_API_KEY;
const TAVILY_API_URL = 'https://api.tavily.com/search';

// ==================== 原生工具调用 (Function Calling) ====================

const FINANCE_ALLOWED_RANGES = new Set(['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'ytd', 'max']);
const FINANCE_ALLOWED_INTERVALS = new Set(['1m', '2m', '5m', '15m', '30m', '60m', '90m', '1d', '1wk', '1mo', '3mo']);
const FINANCE_DEFAULT_RANGE = '1mo';
const FINANCE_DEFAULT_INTERVAL = '1d';
const FINANCE_CACHE_TTL_MS = 60 * 1000;
const FINANCE_QUOTE_CACHE = new Map();
const YAHOO_FINANCE_CHART_BASE_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';
const YAHOO_FINANCE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0 Safari/537.36';

function createFinanceError(statusCode, code, message, details = null) {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.code = code;
    error.details = details;
    return error;
}

function normalizeFinanceSymbolInput(symbol = '') {
    return String(symbol || '')
        .trim()
        .toUpperCase()
        .replace(/\s+/g, '')
        .replace(/，/g, ',');
}

function resolveFinanceSymbol(symbol = '') {
    const normalized = normalizeFinanceSymbolInput(symbol);
    if (!normalized) {
        throw createFinanceError(400, 'invalid_symbol', 'symbol 不能为空');
    }

    if (/^[A-Z0-9^._=-]{1,20}\.(SS|SZ|HK)$/.test(normalized) || /^[A-Z][A-Z0-9^._=-]{0,19}$/.test(normalized)) {
        return normalized;
    }

    if (/^6\d{5}$/.test(normalized)) return `${normalized}.SS`;
    if (/^(0\d{5}|3\d{5})$/.test(normalized)) return `${normalized}.SZ`;
    if (/^\d{4,5}$/.test(normalized)) return `${normalized}.HK`;

    throw createFinanceError(400, 'invalid_symbol', `无法识别的证券代码: ${symbol}`);
}

function normalizeFinanceRange(range = FINANCE_DEFAULT_RANGE) {
    const normalized = String(range || FINANCE_DEFAULT_RANGE).trim().toLowerCase();
    if (!FINANCE_ALLOWED_RANGES.has(normalized)) {
        throw createFinanceError(400, 'invalid_range', `不支持的 range: ${range}`, {
            allowed: Array.from(FINANCE_ALLOWED_RANGES)
        });
    }
    return normalized;
}

function normalizeFinanceInterval(interval = FINANCE_DEFAULT_INTERVAL) {
    const normalized = String(interval || FINANCE_DEFAULT_INTERVAL).trim().toLowerCase();
    if (!FINANCE_ALLOWED_INTERVALS.has(normalized)) {
        throw createFinanceError(400, 'invalid_interval', `不支持的 interval: ${interval}`, {
            allowed: Array.from(FINANCE_ALLOWED_INTERVALS)
        });
    }
    return normalized;
}

function toFiniteNumber(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function toIsoTimestamp(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return '';
    return new Date(numeric * 1000).toISOString();
}

function buildFinanceSeries(result = {}) {
    const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
    const quoteSeries = result.indicators?.quote?.[0] || {};
    const opens = Array.isArray(quoteSeries.open) ? quoteSeries.open : [];
    const highs = Array.isArray(quoteSeries.high) ? quoteSeries.high : [];
    const lows = Array.isArray(quoteSeries.low) ? quoteSeries.low : [];
    const closes = Array.isArray(quoteSeries.close) ? quoteSeries.close : [];
    const volumes = Array.isArray(quoteSeries.volume) ? quoteSeries.volume : [];

    return timestamps.map((timestamp, index) => ({
        timestamp: toIsoTimestamp(timestamp),
        open: toFiniteNumber(opens[index]),
        high: toFiniteNumber(highs[index]),
        low: toFiniteNumber(lows[index]),
        close: toFiniteNumber(closes[index]),
        volume: toFiniteNumber(volumes[index])
    })).filter((item) => item.timestamp && (
        item.open !== null ||
        item.high !== null ||
        item.low !== null ||
        item.close !== null ||
        item.volume !== null
    ));
}

function buildFinanceWarnings(resolvedSymbol = '') {
    const warnings = ['Yahoo Finance 免费数据可能存在延迟，不应视为逐笔实时成交数据。'];
    if (/\.(SS|SZ|HK)$/.test(resolvedSymbol)) {
        warnings.push('A股 / 港股通常为延迟行情，适合参考，不适合作为高频交易依据。');
    }
    return warnings;
}

function normalizeFinanceQuoteResponse(chartResult, {
    symbol,
    resolvedSymbol,
    range,
    interval,
    cacheHit = false
}) {
    const meta = chartResult?.meta || {};
    const series = buildFinanceSeries(chartResult);
    const lastSeriesPoint = [...series].reverse().find((point) => point.close !== null) || null;

    const price = toFiniteNumber(
        meta.regularMarketPrice ??
        meta.postMarketPrice ??
        meta.preMarketPrice ??
        lastSeriesPoint?.close
    );
    const previousClose = toFiniteNumber(
        meta.chartPreviousClose ??
        meta.previousClose ??
        meta.regularMarketPreviousClose
    );
    const change = (price !== null && previousClose !== null) ? Number((price - previousClose).toFixed(6)) : null;
    const changePercent = (change !== null && previousClose) ? Number(((change / previousClose) * 100).toFixed(4)) : null;

    return {
        symbol: normalizeFinanceSymbolInput(symbol),
        resolvedSymbol,
        range,
        interval,
        source: 'Yahoo Finance via RAI proxy',
        delayed: true,
        meta: {
            shortName: meta.shortName || '',
            longName: meta.longName || '',
            currency: meta.currency || '',
            exchangeName: meta.exchangeName || '',
            instrumentType: meta.instrumentType || '',
            marketState: meta.marketState || '',
            timezone: meta.exchangeTimezoneName || meta.timezone || ''
        },
        quote: {
            price,
            previousClose,
            change,
            changePercent,
            timestamp: toIsoTimestamp(meta.regularMarketTime || chartResult?.timestamp?.slice(-1)?.[0] || 0)
        },
        series,
        cache: {
            hit: cacheHit,
            ttlSeconds: Math.floor(FINANCE_CACHE_TTL_MS / 1000)
        },
        warnings: buildFinanceWarnings(resolvedSymbol)
    };
}

async function fetchYahooFinanceQuote({ symbol, range = FINANCE_DEFAULT_RANGE, interval = FINANCE_DEFAULT_INTERVAL }) {
    const resolvedSymbol = resolveFinanceSymbol(symbol);
    const normalizedRange = normalizeFinanceRange(range);
    const normalizedInterval = normalizeFinanceInterval(interval);
    const cacheKey = `${resolvedSymbol}|${normalizedRange}|${normalizedInterval}`;
    const now = Date.now();

    const cached = FINANCE_QUOTE_CACHE.get(cacheKey);
    if (cached && (now - cached.ts) < FINANCE_CACHE_TTL_MS) {
        return {
            ...cached.data,
            cache: {
                ...cached.data.cache,
                hit: true
            }
        };
    }

    const requestUrl = `${YAHOO_FINANCE_CHART_BASE_URL}/${encodeURIComponent(resolvedSymbol)}?${new URLSearchParams({
        range: normalizedRange,
        interval: normalizedInterval
    }).toString()}`;

    let response;
    try {
        response = await fetch(requestUrl, {
            headers: {
                'User-Agent': YAHOO_FINANCE_USER_AGENT,
                Accept: 'application/json'
            }
        });
    } catch (error) {
        throw createFinanceError(502, 'upstream_request_failed', `Yahoo Finance 请求失败: ${error.message}`);
    }

    if (!response.ok) {
        const errText = await response.text();
        throw createFinanceError(502, 'upstream_bad_status', `Yahoo Finance 返回异常状态: ${response.status}`, {
            status: response.status,
            preview: errText.slice(0, 200)
        });
    }

    let payload;
    try {
        payload = await response.json();
    } catch (error) {
        throw createFinanceError(502, 'upstream_invalid_json', `Yahoo Finance 返回数据无法解析: ${error.message}`);
    }

    const chartResult = payload?.chart?.result?.[0];
    const chartError = payload?.chart?.error;
    if (!chartResult || chartError) {
        throw createFinanceError(502, 'upstream_no_chart', chartError?.description || 'Yahoo Finance 未返回有效行情数据', {
            symbol: resolvedSymbol
        });
    }

    const normalized = normalizeFinanceQuoteResponse(chartResult, {
        symbol,
        resolvedSymbol,
        range: normalizedRange,
        interval: normalizedInterval,
        cacheHit: false
    });

    FINANCE_QUOTE_CACHE.set(cacheKey, {
        ts: now,
        data: normalized
    });

    return normalized;
}





function normalizeKolorsImageArgs(args = {}) {
    const prompt = String(args.prompt || args.description || '').trim().slice(0, 2000);
    if (!prompt) {
        throw new Error('图片生成缺少 prompt');
    }

    const requestedSize = String(args.image_size || args.size || '').trim();
    const imageSize = KOLORS_IMAGE_SIZES.includes(requestedSize) ? requestedSize : '1024x1024';
    const normalized = {
        prompt,
        image_size: imageSize,
        batch_size: clampInteger(args.batch_size, 1, 4, 1),
        num_inference_steps: clampInteger(args.num_inference_steps, 1, 100, 20),
        guidance_scale: clampNumber(args.guidance_scale, 0, 20, 7.5)
    };

    const image = String(args.image || args.image_url || '').trim();
    if (/^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(image)) {
        normalized.image = image;
    }

    return normalized;
}

function sniffImageBuffer(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
    if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
        return { contentType: 'image/png', ext: 'png' };
    }
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        return { contentType: 'image/jpeg', ext: 'jpg' };
    }
    const header6 = buffer.subarray(0, 6).toString('ascii');
    if (header6 === 'GIF87a' || header6 === 'GIF89a') {
        return { contentType: 'image/gif', ext: 'gif' };
    }
    if (
        buffer.length >= 12 &&
        buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
        buffer.subarray(8, 12).toString('ascii') === 'WEBP'
    ) {
        return { contentType: 'image/webp', ext: 'webp' };
    }
    return null;
}

function getGeneratedImageExtension(contentType = '', fallbackUrl = '', buffer = null) {
    const normalizedType = String(contentType || '').split(';')[0].trim().toLowerCase();
    if (normalizedType === 'image/jpeg' || normalizedType === 'image/jpg') return 'jpg';
    if (normalizedType === 'image/png') return 'png';
    if (normalizedType === 'image/webp') return 'webp';
    if (normalizedType === 'image/gif') return 'gif';

    const sniffed = sniffImageBuffer(buffer);
    if (sniffed?.ext) return sniffed.ext;

    try {
        const urlPath = fallbackUrl.startsWith('data:')
            ? ''
            : new URL(fallbackUrl).pathname;
        const ext = path.extname(urlPath).toLowerCase().replace(/^\./, '');
        if (['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) {
            return ext === 'jpeg' ? 'jpg' : ext;
        }
    } catch (e) {
        // ignore invalid URL
    }
    return 'png';
}

function normalizeHostname(hostname = '') {
    return String(hostname || '')
        .trim()
        .toLowerCase()
        .replace(/^\[|\]$/g, '')
        .replace(/\.$/, '');
}

function isHostnameAllowedBySet(hostname = '', allowedHosts = null) {
    if (!allowedHosts || allowedHosts.size === 0) return true;
    const host = normalizeHostname(hostname);
    if (!host) return false;
    for (const allowed of allowedHosts) {
        const safeAllowed = normalizeHostname(allowed);
        if (!safeAllowed) continue;
        if (host === safeAllowed || host.endsWith(`.${safeAllowed}`)) return true;
    }
    return false;
}

function parseIpv4Address(address = '') {
    const parts = String(address || '').split('.');
    if (parts.length !== 4) return null;
    const numbers = parts.map((part) => {
        if (!/^\d{1,3}$/.test(part)) return NaN;
        return Number(part);
    });
    if (numbers.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    return numbers;
}

function isPrivateOrReservedIpv4(address = '') {
    const parts = parseIpv4Address(address);
    if (!parts) return false;
    const [a, b, c, d] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 192 && b === 0) return true;
    if (a === 192 && b === 0 && c === 2) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a === 198 && b === 51 && c === 100) return true;
    if (a === 203 && b === 0 && c === 113) return true;
    if (a >= 224) return true;
    if (a === 255 && b === 255 && c === 255 && d === 255) return true;
    return false;
}

function isPrivateOrReservedIpv6(address = '') {
    let ip = normalizeHostname(address);
    if (!ip) return false;
    if (ip.startsWith('::ffff:')) {
        const mapped = ip.slice('::ffff:'.length);
        if (net.isIP(mapped) === 4) return isPrivateOrReservedIpv4(mapped);
    }
    if (ip === '::' || ip === '::1') return true;
    if (ip.startsWith('fe80:') || ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb')) return true;
    if (/^f[c-d][0-9a-f]{2}:/i.test(ip)) return true;
    if (ip.startsWith('2001:db8:')) return true;
    return false;
}

function isPrivateOrReservedIp(address = '') {
    const normalized = normalizeHostname(address);
    const ipVersion = net.isIP(normalized);
    if (ipVersion === 4) return isPrivateOrReservedIpv4(normalized);
    if (ipVersion === 6) return isPrivateOrReservedIpv6(normalized);
    return false;
}

async function resolveImageUrlAddresses(urlObj) {
    const hostname = normalizeHostname(urlObj.hostname);
    if (!hostname) throw new Error('image_url_missing_host');
    if (net.isIP(hostname)) return [{ address: hostname, family: net.isIP(hostname) }];
    const records = await dns.lookup(hostname, { all: true, verbatim: true });
    if (!records || records.length === 0) {
        throw new Error('image_url_dns_empty');
    }
    return records;
}

async function assertSafeOutboundImageUrl(rawUrl, options = {}) {
    const source = String(rawUrl || '').trim();
    let urlObj;
    try {
        urlObj = new URL(source);
    } catch (error) {
        throw new Error('image_url_invalid');
    }

    if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
        throw new Error('image_url_protocol_blocked');
    }
    if (urlObj.username || urlObj.password) {
        throw new Error('image_url_credentials_blocked');
    }

    const hostname = normalizeHostname(urlObj.hostname);
    if (!hostname) throw new Error('image_url_missing_host');
    if (!isHostnameAllowedBySet(hostname, options.allowedHosts || null)) {
        throw new Error('image_url_host_not_allowed');
    }

    const addresses = await resolveImageUrlAddresses(urlObj);
    const blocked = addresses.find((record) => isPrivateOrReservedIp(record.address));
    if (blocked) {
        const error = new Error('image_url_private_address_blocked');
        error.address = blocked.address;
        throw error;
    }
    return urlObj;
}

function buildRedirectedUrl(locationHeader = '', currentUrlObj) {
    const location = String(locationHeader || '').trim();
    if (!location) return '';
    try {
        return new URL(location, currentUrlObj).href;
    } catch (error) {
        return '';
    }
}

async function readResponseBufferWithLimit(response, maxBytes) {
    const chunks = [];
    let total = 0;
    if (!response.body || typeof response.body.getReader !== 'function') {
        const fallbackBuffer = Buffer.from(await response.arrayBuffer());
        if (fallbackBuffer.length > maxBytes) throw new Error(`image too large: ${fallbackBuffer.length}`);
        return fallbackBuffer;
    }

    const reader = response.body.getReader();
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = Buffer.from(value);
            total += chunk.length;
            if (total > maxBytes) {
                await reader.cancel().catch(() => null);
                throw new Error(`image too large: ${total}`);
            }
            chunks.push(chunk);
        }
    } finally {
        reader.releaseLock();
    }
    return Buffer.concat(chunks, total);
}

function logBlockedGeneratedImageFetch(sourceUrl, error) {
    const hostname = (() => {
        try {
            return normalizeHostname(new URL(String(sourceUrl || '')).hostname);
        } catch (e) {
            return '';
        }
    })();
    console.warn(` 生成图片下载被安全策略拦截: host=${hostname || 'unknown'}, reason=${error.message}`);
    appendRaiRuntimeReport({
        level: '警告',
        tag: 'generated_image_ssrf_blocked',
        message: '生成图片下载被 SSRF 防护拦截',
        context: {
            host: hostname,
            reason: error.message,
            address: error.address || null
        }
    });
}

async function fetchGeneratedImageBuffer(sourceUrl) {
    let currentUrl = String(sourceUrl || '').trim();
    for (let redirectCount = 0; redirectCount <= SAFE_IMAGE_FETCH_MAX_REDIRECTS; redirectCount += 1) {
        let urlObj;
        try {
            urlObj = await assertSafeOutboundImageUrl(currentUrl, {
                allowedHosts: GENERATED_IMAGE_ALLOWED_SOURCE_HOSTS
            });
        } catch (error) {
            logBlockedGeneratedImageFetch(currentUrl, error);
            throw error;
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), GENERATED_IMAGE_FETCH_TIMEOUT_MS);
        let imageResponse;
        try {
            imageResponse = await fetch(urlObj.href, {
                redirect: 'manual',
                signal: controller.signal,
                headers: {
                    'User-Agent': 'RAI/1.0 image-cache',
                    'Accept': 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.8,*/*;q=0.1'
                }
            });
        } finally {
            clearTimeout(timeout);
        }

        if (imageResponse.status >= 300 && imageResponse.status < 400) {
            const nextUrl = buildRedirectedUrl(imageResponse.headers.get('location') || '', urlObj);
            if (!nextUrl) throw new Error('image_redirect_invalid');
            const nextUrlObj = new URL(nextUrl);
            if (normalizeHostname(nextUrlObj.hostname) !== normalizeHostname(urlObj.hostname)) {
                throw new Error('image_redirect_cross_host_blocked');
            }
            currentUrl = nextUrl;
            continue;
        }

        if (!imageResponse.ok) {
            throw new Error(`image download failed with HTTP ${imageResponse.status}`);
        }
        const contentType = imageResponse.headers.get('content-type') || '';
        const contentLength = Number(imageResponse.headers.get('content-length') || 0);
        if (contentLength > MAX_GENERATED_IMAGE_BYTES) {
            throw new Error(`image too large: ${contentLength}`);
        }
        const buffer = await readResponseBufferWithLimit(imageResponse, MAX_GENERATED_IMAGE_BYTES);
        return { buffer, contentType };
    }
    throw new Error('image_redirect_limit_exceeded');
}

async function fetchSafeImageHead(imageUrl, timeout = IMAGE_URL_HEAD_TIMEOUT_MS) {
    let currentUrl = String(imageUrl || '').trim();
    for (let redirectCount = 0; redirectCount <= SAFE_IMAGE_FETCH_MAX_REDIRECTS; redirectCount += 1) {
        const urlObj = await assertSafeOutboundImageUrl(currentUrl);
        const controller = new AbortController();
        const timeoutHandle = setTimeout(() => controller.abort(), timeout);
        let response;
        try {
            response = await fetch(urlObj.href, {
                method: 'HEAD',
                redirect: 'manual',
                signal: controller.signal,
                headers: {
                    'User-Agent': 'RAI/1.0 image-url-check',
                    'Accept': 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.8,*/*;q=0.1'
                }
            });
        } finally {
            clearTimeout(timeoutHandle);
        }

        if (response.status >= 300 && response.status < 400) {
            const nextUrl = buildRedirectedUrl(response.headers.get('location') || '', urlObj);
            if (!nextUrl) return false;
            currentUrl = nextUrl;
            continue;
        }

        if (response.status < 200 || response.status >= 300) return false;
        const contentType = String(response.headers.get('content-type') || '').toLowerCase();
        return !contentType || contentType.startsWith('image/');
    }
    return false;
}

async function persistGeneratedImage(imageUrl = '', index = 0) {
    const sourceUrl = String(imageUrl || '').trim();
    if (!sourceUrl) return null;

    let buffer;
    let contentType = '';
    if (/^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(sourceUrl)) {
        const match = sourceUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/);
        if (!match) return null;
        contentType = match[1];
        buffer = Buffer.from(match[2], 'base64');
    } else if (/^https?:\/\//i.test(sourceUrl)) {
        const downloaded = await fetchGeneratedImageBuffer(sourceUrl);
        buffer = downloaded.buffer;
        contentType = downloaded.contentType;
    } else {
        return null;
    }

    if (!buffer || buffer.length === 0) return null;
    if (buffer.length > MAX_GENERATED_IMAGE_BYTES) {
        throw new Error(`image too large: ${buffer.length}`);
    }
    const sniffed = sniffImageBuffer(buffer);
    if (contentType && !/^image\//i.test(contentType) && !sniffed) {
        throw new Error(`image download returned non-image content-type: ${contentType}`);
    }
    if (!contentType || !/^image\//i.test(contentType)) {
        contentType = sniffed?.contentType || '';
    }
    if (!contentType || !/^image\//i.test(contentType)) {
        throw new Error('image download returned unrecognized image bytes');
    }

    await fs.promises.mkdir(GENERATED_IMAGES_DIR, { recursive: true });
    const ext = getGeneratedImageExtension(contentType, sourceUrl, buffer);
    const filename = `kolors-${Date.now()}-${crypto.randomBytes(6).toString('hex')}-${index + 1}.${ext}`;
    const filePath = path.join(GENERATED_IMAGES_DIR, filename);
    await fs.promises.writeFile(filePath, buffer);
    return {
        url: `${GENERATED_IMAGE_PUBLIC_PREFIX}/${filename}`,
        bytes: buffer.length,
        content_type: contentType || `image/${ext === 'jpg' ? 'jpeg' : ext}`
    };
}

async function generateKolorsImages(rawArgs = {}) {
    const args = normalizeKolorsImageArgs(rawArgs);
    const provider = API_PROVIDERS.siliconflow;
    if (!provider?.apiKey) {
        throw new Error(`缺少环境变量: ${provider?.envKey || 'SILICONFLOW_API_KEY'}`);
    }

    const requestBody = {
        model: KOLORS_IMAGE_MODEL,
        ...args
    };

    const endpoint = provider.imageGenerationURL || SILICONFLOW_IMAGE_GENERATION_URL;
    let response;
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 120000);
        try {
            response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${provider.apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestBody),
                signal: controller.signal
            });
        } catch (error) {
            appendRaiRuntimeReport({
                level: '报错',
                tag: 'image_generation_network_failed',
                message: error.message,
                context: {
                    provider: 'siliconflow',
                    model: KOLORS_IMAGE_MODEL,
                    endpoint,
                    attempt,
                    image_size: args.image_size,
                    batch_size: args.batch_size
                }
            });
            if (attempt < maxAttempts) {
                await new Promise((resolve) => setTimeout(resolve, 1200));
                continue;
            }
            throw error;
        } finally {
            clearTimeout(timeoutId);
        }

        if (response.ok || response.status < 500 || attempt >= maxAttempts) {
            break;
        }
        appendRaiRuntimeReport({
            level: '报错',
            tag: 'image_generation_retry',
            message: `Kolors image generation HTTP ${response.status}, retrying`,
            context: {
                provider: 'siliconflow',
                model: KOLORS_IMAGE_MODEL,
                endpoint,
                attempt,
                image_size: args.image_size,
                batch_size: args.batch_size
            }
        });
        await response.arrayBuffer().catch(() => null);
        await new Promise((resolve) => setTimeout(resolve, 1200));
    }

    if (!response.ok) {
        const errorText = await response.text();
        appendRaiRuntimeReport({
            level: '报错',
            tag: 'image_generation_http_failed',
            message: `Kolors image generation failed with HTTP ${response.status}`,
            context: {
                provider: 'siliconflow',
                model: KOLORS_IMAGE_MODEL,
                endpoint,
                status: response.status,
                body: errorText,
                image_size: args.image_size,
                batch_size: args.batch_size
            }
        });
        throw new Error(`图片生成失败 ${response.status}: ${errorText.substring(0, 300)}`);
    }

    let payload;
    try {
        payload = await response.json();
    } catch (error) {
        appendRaiRuntimeReport({
            level: '报错',
            tag: 'image_generation_invalid_json',
            message: error.message,
            context: {
                provider: 'siliconflow',
                model: KOLORS_IMAGE_MODEL,
                endpoint
            }
        });
        throw new Error(`图片生成返回无法解析: ${error.message}`);
    }

    const rawImages = Array.isArray(payload?.images)
        ? payload.images
        : (Array.isArray(payload?.data) ? payload.data : []);
    const images = (await Promise.all(rawImages.map(async (item, index) => {
        const url = String(item?.url || item?.image_url || '').trim();
        const b64 = String(item?.b64_json || '').trim();
        const imageUrl = url || (b64 ? `data:image/png;base64,${b64}` : '');
        if (!imageUrl) return null;

        try {
            const persisted = await persistGeneratedImage(imageUrl, index);
            if (persisted?.url) {
                return {
                    index: index + 1,
                    url: persisted.url,
                    bytes: persisted.bytes,
                    content_type: persisted.content_type
                };
            }
        } catch (error) {
            appendRaiRuntimeReport({
                level: '报错',
                tag: 'image_generation_persist_failed',
                message: error.message,
                context: {
                    provider: 'siliconflow',
                    model: KOLORS_IMAGE_MODEL,
                    sourceUrl: imageUrl
                }
            });
        }

        return null;
    }))).filter(Boolean);

    if (images.length === 0) {
        appendRaiRuntimeReport({
            level: '报错',
            tag: 'image_generation_empty_result',
            message: 'Kolors returned no image URL',
            context: {
                provider: 'siliconflow',
                model: KOLORS_IMAGE_MODEL,
                payload
            }
        });
        throw new Error('图片生成没有返回图片 URL');
    }

    return {
        provider: 'siliconflow',
        model: KOLORS_IMAGE_MODEL,
        endpoint,
        prompt: args.prompt,
        parameters: {
            image_size: args.image_size,
            batch_size: args.batch_size,
            num_inference_steps: args.num_inference_steps,
            guidance_scale: args.guidance_scale
        },
        images,
        seed: payload?.seed ?? payload?.timings?.seed ?? null,
        note: 'Generated images were cached by RAI. Use only the local /generated-images/ URLs.'
    };
}

// 工具定义 - Kimi K2.6 / Qwen 3.6 等 OpenAI 兼容路由使用
const TOOL_DEFINITIONS = [{
    type: "function",
    function: {
        name: "web_search",
        description: "搜索互联网获取实时信息。当问题涉及新闻、天气、股价、最新事件、实时数据、需要验证的事实时调用此工具。",
        parameters: {
            type: "object",
            required: ["query"],
            properties: {
                query: {
                    type: "string",
                    description: "优化后的搜索关键词，英文优先以获得更好结果"
                }
            }
        }
    }
}, {
    type: "function",
    function: {
        name: "generate_image",
        description: "使用硅基流动托管的 Kwai-Kolors/Kolors 文生图。当用户要求画图、生图、生成海报、插画、视觉方案或图片时调用。只传 prompt 和尺寸等参数，不要传 image、image_url 或参考图 URL。服务端会自动把图片展示给用户。",
        parameters: {
            type: "object",
            required: ["prompt"],
            additionalProperties: false,
            properties: {
                prompt: {
                    type: "string",
                    description: "图片生成提示词。应包含主体、场景、风格、构图、光线、颜色和需要避免的歧义。"
                },
                image_size: {
                    type: "string",
                    enum: KOLORS_IMAGE_SIZES,
                    description: "图片尺寸，默认 1024x1024。"
                },
                batch_size: {
                    type: "integer",
                    minimum: 1,
                    maximum: 4,
                    description: "生成张数，1 到 4，默认 1。"
                },
                num_inference_steps: {
                    type: "integer",
                    minimum: 1,
                    maximum: 100,
                    description: "推理步数，默认 20。"
                },
                guidance_scale: {
                    type: "number",
                    minimum: 0,
                    maximum: 20,
                    description: "提示词遵循强度，默认 7.5。"
                }
            }
        }
    }
}, {
    type: "function",
    function: {
        name: "finance_quote",
        description: "获取股票、ETF、指数的行情和历史K线数据。适用于证券代码、价格、涨跌幅、历史走势、K线区间等问题。A股/港股通常为延迟数据。",
        parameters: {
            type: "object",
            required: ["symbol"],
            properties: {
                symbol: {
                    type: "string",
                    description: "证券代码，例如 600519.SS、0700.HK、AAPL、SPY"
                },
                range: {
                    type: "string",
                    description: "历史区间，可选 1d,5d,1mo,3mo,6mo,1y,2y,5y,10y,ytd,max"
                },
                interval: {
                    type: "string",
                    description: "K线周期，可选 1m,2m,5m,15m,30m,60m,90m,1d,1wk,1mo,3mo"
                }
            }
        }
    }
}];

const MEMORY_DELETE_TOOL_DEFINITION = {
    type: "function",
    function: {
        name: "delete_memory",
        description: "删除用户已保存的一条或多条长期记忆。仅当用户明确要求忘记、删除、移除长期记忆时调用。优先使用[长期记忆]里#后的 memory_id / memory_ids；没有编号时传入要删除的准确记忆文本。",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                memory_id: {
                    type: "integer",
                    description: "长期记忆列表中#后的数字ID，优先使用。"
                },
                memory_ids: {
                    type: "array",
                    items: {
                        type: "integer"
                    },
                    description: "一次需要删除多条长期记忆时，传入多个#后的数字ID，例如用户确认“这两条都删掉”。"
                },
                target: {
                    type: "string",
                    description: "没有 memory_id 时，传入要删除的记忆原文或足够精确的目标文本。"
                },
                reason: {
                    type: "string",
                    description: "简短说明用户为什么要求删除，可省略。"
                }
            }
        }
    }
};

function hasToolDefinition(toolDefinitions = [], toolName = '') {
    return toolDefinitions.some((tool) => tool?.function?.name === toolName);
}

function buildChatToolDefinitions({
    internetMode = false,
    imageGenerationRequested = false,
    memoryDeleteToolRequested = false
} = {}) {
    const definitions = [];
    if (internetMode || imageGenerationRequested) {
        definitions.push(...TOOL_DEFINITIONS);
    }
    if (memoryDeleteToolRequested && !hasToolDefinition(definitions, 'delete_memory')) {
        definitions.push(MEMORY_DELETE_TOOL_DEFINITION);
    }
    return definitions;
}

function uniquePositiveMemoryIds(values = []) {
    const ids = [];
    const seen = new Set();
    const add = (value) => {
        const id = Number(value);
        if (!Number.isInteger(id) || id <= 0 || seen.has(id)) return;
        seen.add(id);
        ids.push(id);
    };

    const walk = (value) => {
        if (Array.isArray(value)) {
            value.forEach(walk);
            return;
        }
        if (typeof value === 'number') {
            add(value);
            return;
        }
        if (typeof value === 'string') {
            for (const match of value.matchAll(/\d+/g)) {
                add(match[0]);
            }
        }
    };

    walk(values);
    return ids;
}

function extractMemoryIdsFromText(text = '') {
    const ids = [];
    const seen = new Set();
    for (const match of String(text || '').matchAll(/#\s*(\d+)/g)) {
        const id = Number(match[1]);
        if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
    }
    return ids;
}

function formatMemoryIdList(ids = []) {
    return uniquePositiveMemoryIds(ids).map((id) => `#${id}`).join('、');
}

function normalizeDeleteMemoryToolArgs(args = {}) {
    const rawTarget = sanitizeMemoryContent(args.target || args.memory || args.content || '');
    const explicitIds = uniquePositiveMemoryIds([
        args.memory_ids,
        args.memoryIds,
        args.ids,
        args.memory_id,
        args.memoryId,
        args.id
    ]);
    const memoryIds = uniquePositiveMemoryIds([...explicitIds, ...extractMemoryIdsFromText(rawTarget)]);
    const reason = sanitizeMemoryContent(args.reason || '').slice(0, 180);
    if (memoryIds.length === 0 && !rawTarget) return null;
    return {
        ...(memoryIds.length > 1 ? { memory_ids: memoryIds } : {}),
        ...(memoryIds.length === 1 ? { memory_id: memoryIds[0] } : {}),
        ...(rawTarget ? { target: rawTarget } : {}),
        ...(reason ? { reason } : {})
    };
}

// 工具执行器映射
const TOOL_EXECUTORS = {
    web_search: async (args, searchDepth = 'basic') => {
        const maxResults = 5;
        console.log(` 执行工具 web_search: query="${args.query}", depth=${searchDepth}, max=${maxResults}`);
        return await performWebSearch(args.query, maxResults, searchDepth);
    },
    finance_quote: async (args) => {
        console.log(` 执行工具 finance_quote: symbol="${args.symbol}", range="${args.range || FINANCE_DEFAULT_RANGE}", interval="${args.interval || FINANCE_DEFAULT_INTERVAL}"`);
        return await fetchYahooFinanceQuote(args);
    },
    generate_image: async (args) => {
        const safeArgs = normalizeKolorsImageArgs(args);
        console.log(` 执行工具 generate_image: model=${KOLORS_IMAGE_MODEL}, size=${safeArgs.image_size}, batch=${safeArgs.batch_size}`);
        return await generateKolorsImages(safeArgs);
    },
    delete_memory: async (args, context = {}) => {
        const safeArgs = normalizeDeleteMemoryToolArgs(args);
        console.log(` 执行工具 delete_memory: userId=${context?.userId || 'missing'}, ids=${formatMemoryIdList(safeArgs?.memory_ids || safeArgs?.memory_id || []) || 'none'}, target="${safeArgs?.target || ''}"`);
        return await deleteUserMemoryByModel({
            userId: context?.userId,
            memoryId: safeArgs?.memory_id,
            memoryIds: safeArgs?.memory_ids,
            target: safeArgs?.target,
            reason: safeArgs?.reason
        });
    }
};

// ==================== Multi-Agent 编排 (主控 + 动态1~4子AI) ====================

const AGENT_DEFAULT_POLICY = 'dynamic-1-4';
const AGENT_DEFAULT_QUALITY = 'high';
const AGENT_MAX_RETRIES = 2;
const AGENT_ROLES = ['planner', 'researcher', 'synthesizer', 'verifier'];

const FRESHNESS_KEYWORDS = [
    '现在', '最新', '今天', '实时', 'recent', 'latest', 'today', 'now',
    'news', '天气', '股价', '价格', '汇率', '比分', '政策', '更新'
];

const HIGH_RISK_KEYWORDS = [
    '医疗', '诊断', '处方', '药', '手术', '健康',
    '法律', '合同', '诉讼', '合规', '税务',
    '金融', '投资', '理财', '杠杆', '证券', '贷款',
    'medical', 'diagnosis', 'prescription', 'legal', 'lawsuit',
    'finance', 'investment', 'tax', 'compliance', 'security'
];

const HIGH_ACCURACY_KEYWORDS = [
    '高准确', '高精度', '严谨', '严格', '请务必准确',
    'high accuracy', 'strictly accurate', 'double check'
];

// ==================== 关键词规则注入引擎（首版硬编码） ====================
const PROMPT_INJECTION_RULES = [
    {
        id: 'logic_carwash_distance',
        enabled: true,
        priority: 100,
        match: {
            keywords: ['洗车', '50', '开车', '走路'],
            minMatchCount: 3,
            scope: 'current_message',
            caseInsensitive: true
        },
        mustIncludeAny: ['洗车'],
        excludeIfAny: [],
        instruction: [
            '这是常识逻辑题时，优先指出“洗的是车不是人”。',
            '核心结论：默认应“开车去洗车”，并说明走路无法把车带去洗。',
            '若用户补充“车不在身边/车已在店里”等前提，再按新前提重判。'
        ].join('\n'),
        notes: '洗车场景逻辑强化'
    },
    {
        id: 'logic_parents_marriage_not_invited',
        enabled: true,
        priority: 90,
        match: {
            keywords: ['爸妈', '父母', '结婚', '没叫我', '不叫我', '没邀请我', '难过', '伤心'],
            minMatchCount: 3,
            scope: 'current_message',
            caseInsensitive: true
        },
        mustIncludeAny: ['结婚'],
        excludeIfAny: [],
        instruction: [
            '回答需明确提醒：“你爸妈结婚时你还没出生，所以‘没叫你’不是针对你。”',
            '表达顺序：先简短共情，再给逻辑澄清，再给安抚建议（1-2条）。'
        ].join('\n'),
        notes: '情绪+逻辑澄清场景'
    }
];

function normalizeForRuleMatch(text = '', caseInsensitive = true) {
    let normalized = String(text || '');
    if (caseInsensitive) normalized = normalized.toLowerCase();
    return normalized
        .replace(/[\r\n\t\s]+/g, '')
        .replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
}

function matchRule(rule, userMessage) {
    if (!rule || !rule.enabled) {
        return { matched: false, matchedKeywords: [], score: 0 };
    }

    const matchConfig = rule.match || {};
    const caseInsensitive = matchConfig.caseInsensitive !== false;
    const sourceText = normalizeForRuleMatch(userMessage, caseInsensitive);
    if (!sourceText) {
        return { matched: false, matchedKeywords: [], score: 0 };
    }

    const keywords = Array.isArray(matchConfig.keywords) ? matchConfig.keywords : [];
    const matchedKeywords = [];
    for (const kw of keywords) {
        const token = normalizeForRuleMatch(kw, caseInsensitive);
        if (!token) continue;
        if (sourceText.includes(token)) matchedKeywords.push(String(kw));
    }

    const minMatchCount = Number(matchConfig.minMatchCount || 1);
    if (matchedKeywords.length < minMatchCount) {
        return {
            matched: false,
            matchedKeywords,
            score: keywords.length > 0 ? matchedKeywords.length / keywords.length : 0
        };
    }

    if (Array.isArray(rule.mustIncludeAny) && rule.mustIncludeAny.length > 0) {
        const mustPass = rule.mustIncludeAny.some((kw) => {
            const token = normalizeForRuleMatch(kw, caseInsensitive);
            return token ? sourceText.includes(token) : false;
        });
        if (!mustPass) {
            return {
                matched: false,
                matchedKeywords,
                score: keywords.length > 0 ? matchedKeywords.length / keywords.length : 0
            };
        }
    }

    if (Array.isArray(rule.excludeIfAny) && rule.excludeIfAny.length > 0) {
        const blocked = rule.excludeIfAny.some((kw) => {
            const token = normalizeForRuleMatch(kw, caseInsensitive);
            return token ? sourceText.includes(token) : false;
        });
        if (blocked) {
            return {
                matched: false,
                matchedKeywords,
                score: keywords.length > 0 ? matchedKeywords.length / keywords.length : 0
            };
        }
    }

    return {
        matched: true,
        matchedKeywords,
        score: keywords.length > 0 ? matchedKeywords.length / keywords.length : 1
    };
}

function resolvePromptInjection(userMessage) {
    const candidates = [];
    for (const rule of PROMPT_INJECTION_RULES) {
        if (!rule?.enabled) continue;
        if (rule?.match?.scope && rule.match.scope !== 'current_message') continue;
        const result = matchRule(rule, userMessage);
        if (!result.matched) continue;
        candidates.push({
            rule,
            matchedKeywords: result.matchedKeywords,
            score: result.score
        });
    }
    if (candidates.length === 0) return null;

    candidates.sort((a, b) => {
        const pa = Number(a.rule.priority || 0);
        const pb = Number(b.rule.priority || 0);
        if (pb !== pa) return pb - pa;
        return (b.score || 0) - (a.score || 0);
    });

    const selected = candidates[0];
    return {
        ruleId: selected.rule.id,
        instruction: String(selected.rule.instruction || '').trim(),
        matchedKeywords: selected.matchedKeywords
    };
}

function buildRuleInjectionInstruction(resolvedRule) {
    if (!resolvedRule?.instruction) return '';
    const matched = Array.isArray(resolvedRule.matchedKeywords)
        ? resolvedRule.matchedKeywords.join('、')
        : '';
    return [
        '[规则注入-高优先级]',
        '你必须严格遵守以下逻辑约束（优先级高于一般风格要求）：',
        `规则ID: ${resolvedRule.ruleId || 'unknown'}`,
        matched ? `命中关键词: ${matched}` : '',
        String(resolvedRule.instruction || '').trim()
    ].filter(Boolean).join('\n').trim();
}

const DOMAIN_MODE_ALIASES = {
    write: 'writing',
    writing: 'writing',
    writer: 'writing',
    '写作': 'writing',
    finance: 'finance',
    financial: 'finance',
    stock: 'finance',
    stocks: 'finance',
    ticker: 'finance',
    quote: 'finance',
    market: 'finance',
    markets: 'finance',
    '财务': 'finance',
    '金融': 'finance',
    '股票': 'finance',
    '证券': 'finance',
    '港股': 'finance',
    'a股': 'finance',
    'A股': 'finance',
    code: 'coding',
    coding: 'coding',
    programmer: 'coding',
    programming: 'coding',
    '代码': 'coding',
    search: 'research',
    research: 'research',
    '搜索': 'research',
    '研究': 'research',
    translate: 'translation',
    translation: 'translation',
    translator: 'translation',
    '翻译': 'translation'
};

const DOMAIN_LABELS = {
    writing: { zh: '写作', en: 'Writing' },
    finance: { zh: '财务', en: 'Finance' },
    coding: { zh: '代码', en: 'Coding' },
    research: { zh: '搜索/研究', en: 'Search/Research' },
    translation: { zh: '翻译', en: 'Translation' }
};

const DOMAIN_SYSTEM_PROMPTS = {
    writing: {
        en: `You are an elite writing consultant with expertise across literary fiction, copywriting, journalism, and content strategy.

CORE DIRECTIVES:
- Analyze the user's intent, audience, tone, and purpose BEFORE writing
- Match voice and register precisely: formal/casual/poetic/persuasive
- Structure with narrative tension: hook -> development -> resolution
- Prioritize specificity over generality; concrete details over abstractions
- Every sentence must earn its place — cut filler, amplify signal

OUTPUT PROTOCOL:
1. Clarify ambiguities with ONE targeted question if needed
2. Produce the primary draft
3. Offer 1-2 variant approaches (different tone/angle/structure)
4. End with brief craft notes explaining key decisions

QUALITY MARKERS: vivid imagery, rhythmic sentence variation, emotional resonance, clear throughline, memorable opening/closing.`,
        zh: `你是一位顶级写作顾问，精通文学创作、文案策划、新闻写作与内容策略。

【核心指令】
- 动笔前先分析用户意图、目标受众、语气基调与写作目的
- 精准匹配文风与语域：正式 / 轻松 / 诗意 / 说服性
- 以叙事张力构建结构：钩子开篇 -> 层层推进 -> 有力收尾
- 用具体细节代替空泛表述，用鲜活意象代替抽象概念
- 每一句话都必须有存在价值，删除冗余，强化信号

【输出规范】
1. 若信息不足，只提一个最关键的问题进行确认
2. 输出主要正文内容
3. 提供 1-2 个备选方向（不同语气 / 角度 / 结构）
4. 附上简短的「创作说明」，解释关键写作决策

【质量标准】
意象鲜明，句式富有节奏，情感共鸣，主线清晰，开头结尾令人印象深刻。`
    },
    finance: {
        en: `You are a market and finance analyst focused on practical stock, ETF, index, and quote interpretation.

CORE DIRECTIVES:
- Use the finance_quote tool first for symbol-based market data, price, change, and K-line/history questions
- Never fabricate prices, percentage changes, or chart trends
- Separate market data from your own interpretation
- Clearly note that free Yahoo Finance data for A-shares and Hong Kong stocks is usually delayed and not tick-level real-time
- If the user does not provide a recognizable ticker or market suffix, ask for the symbol before making claims
- Use web_search only for news, filings, company events, macro background, or analyst commentary

OUTPUT PROTOCOL:
1. Identify the ticker or market first when needed
2. Present a compact market data summary
3. Explain trend, volatility, and key levels in plain language
4. Mark uncertainty and delay risk explicitly
5. Distinguish facts, calculations, and opinion

TOOL PRIORITY:
- Use finance_quote for quotes, price moves, trend ranges, and historical candles
- Use web_search only after finance_quote when news or context is needed
- Cite Yahoo Finance market data with alpha markers like [A], [B] when the tool provides them`,
        zh: `你是一位市场与财务分析助手，专注于股票、ETF、指数与行情解读。

【核心指令】
- 只要问题涉及证券代码、价格、涨跌幅、区间走势、K线、成交量，优先调用 finance_quote 工具取数
- 绝不编造价格、涨跌幅、历史走势或财务市场数据
- 明确区分“市场数据事实”和“你的分析判断”
- 明确提示：Yahoo Finance 免费数据中的 A 股 / 港股通常为延迟行情，并非逐笔实时成交
- 如果用户没有提供可识别的 ticker 或市场后缀，先要求补充证券代码后再下结论
- 只有在需要新闻、公告、财报背景、研报观点、宏观背景时，再结合 web_search

【输出规范】
1. 先识别或确认证券代码 / 市场
2. 先给结构化市场数据摘要
3. 再解释区间趋势、波动、关键价位
4. 明确说明延迟数据与不确定性
5. 清晰区分事实、计算结果与分析意见

【工具优先级】
- finance_quote：用于行情、涨跌、区间走势、历史 K 线
- web_search：用于新闻、公告、事件背景与外部信息补充
- 如果使用 Yahoo Finance 行情数据，请在正文中使用字母角标，例如 [A]、[B]`
    },
    coding: {
        en: `You are a senior software engineer with 15+ years across full-stack, systems, and architecture. You write production-grade code.

CORE DIRECTIVES:
- Understand requirements fully before coding; identify edge cases first
- Write clean, readable, maintainable code, not just functional code
- Follow language-specific best practices and idiomatic patterns
- Consider: performance, security, error handling, scalability
- Never assume; ask about constraints (language version, framework, env)

OUTPUT PROTOCOL:
1. Restate the problem in your own words to confirm understanding
2. Outline your approach BEFORE writing code
3. Provide complete, runnable code with inline comments for non-obvious logic
4. Include: error handling, input validation, edge case notes
5. Add a "Potential Improvements" section for production considerations

QUALITY MARKERS: O(n) complexity awareness, DRY principles, SOLID design, security-conscious patterns, test coverage suggestions.`,
        zh: `你是一位拥有 15 年以上经验的资深软件工程师，精通全栈开发、系统设计与架构规划，只写生产级代码。

【核心指令】
- 完整理解需求后再动手，优先识别边界条件与异常情况
- 代码要干净、可读、易维护，不只是能跑起来
- 遵循对应语言的最佳实践与惯用模式
- 全面考量：性能、安全性、错误处理、可扩展性
- 遇到不确定的约束（语言版本、框架、环境）主动询问

【输出规范】
1. 用自己的话复述问题，确认理解无误
2. 写代码前先阐述实现思路
3. 提供完整可运行的代码，对非显而易见的逻辑加注释
4. 包含：错误处理、输入校验、边界情况说明
5. 末尾附「可优化方向」供生产环境参考

【质量标准】
时间复杂度意识，DRY 原则，SOLID 设计，安全编码习惯，测试覆盖建议。`
    },
    research: {
        en: `You are a research analyst and information strategist trained in academic research, fact-checking, and knowledge synthesis.

CORE DIRECTIVES:
- Decompose complex queries into precise sub-questions
- Distinguish between: verified facts / expert consensus / contested claims / speculation
- Cite source types (peer-reviewed / official / journalistic / anecdotal)
- Flag information currency, and note if data may be outdated
- Identify knowledge gaps and conflicting evidence explicitly

OUTPUT PROTOCOL:
1. Reframe the query for maximum precision
2. Deliver findings in layers: Summary -> Details -> Evidence -> Caveats
3. Use confidence levels: [High / Medium / Low / Unverified]
4. Highlight what is NOT known or disputed
5. Suggest follow-up searches or primary sources

QUALITY MARKERS: epistemic honesty, source triangulation, bias awareness, clear separation of fact vs. interpretation.`,
        zh: `你是一位研究分析师与信息策略专家，擅长学术研究、事实核查与知识综合归纳。

【核心指令】
- 将复杂问题拆解为精确的子问题
- 严格区分：已验证事实 / 专家共识 / 争议观点 / 推测性内容
- 标注信息来源类型（学术论文 / 官方数据 / 新闻报道 / 坊间说法）
- 注明信息时效性，若数据可能过时需显式提示
- 明确指出知识盲区与相互矛盾的证据

【输出规范】
1. 重新精确表述问题
2. 分层输出结论：摘要 -> 详情 -> 证据 -> 注意事项
3. 标注可信度等级：【高】【中】【低】【待核实】
4. 突出显示「尚未明确」或「存在争议」的部分
5. 建议延伸搜索方向或一手信息来源

【质量标准】
认知诚实，多源交叉验证，偏见意识，事实与解读清晰分离。`
    },
    translation: {
        en: `You are a professional translator and computational linguist with deep expertise in cross-cultural communication, localization, and linguistics.

CORE DIRECTIVES:
- Prioritize meaning fidelity over word-for-word literalism
- Preserve: tone, register, cultural nuance, rhetorical effect, humor
- Identify untranslatable concepts and handle them explicitly
- Adapt idioms, metaphors, and cultural references for target audience
- Maintain stylistic fingerprint of the original author

OUTPUT PROTOCOL:
1. Identify source language, target language, domain, and register
2. Deliver primary translation
3. Annotate culturally significant choices with [TN: translator's note]
4. For ambiguous source text, provide 2 interpretations with reasoning
5. Flag any terms with intentional localization decisions

QUALITY MARKERS: natural target-language flow, cultural equivalence, preserved subtext, consistent terminology, register alignment.

SPECIAL MODES (invoke as needed):
- [LITERAL] for academic/legal precision
- [LOCALIZE] for marketing/consumer content
- [PRESERVE STYLE] for literary/creative work`,
        zh: `你是一位职业译者与计算语言学家，深度精通跨文化传播、本地化策略与语言学理论。

【核心指令】
- 以意义忠实为首要原则，而非逐字对译
- 完整保留：语气、语域、文化内涵、修辞效果、幽默感
- 识别不可直译的概念，并给出显式处理方案
- 对习语、隐喻、文化典故进行目标语读者适配
- 保留原作者的文体风格与个人语言特征

【输出规范】
1. 识别源语言、目标语言、专业领域与语域风格
2. 输出主要译文
3. 对有文化负载的翻译决策加注【译注】说明
4. 源文本存在歧义时，提供两种理解方向并附理由
5. 标记所有经过有意本地化处理的术语

【质量标准】
目标语行文自然，文化等效，潜台词保留，术语一致，语域对齐。

【特殊模式（按需启用）】
[直译模式] 适用于学术/法律类精确场景
[本地化模式] 适用于营销/消费者内容
[保留文风模式] 适用于文学/创意写作`
    }
};

function normalizeDomainMode(value = '') {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const lower = raw.toLowerCase();
    return DOMAIN_MODE_ALIASES[lower] || DOMAIN_MODE_ALIASES[raw] || '';
}

function resolvePromptLanguage(uiLanguage = '', userMessage = '') {
    const lang = String(uiLanguage || '').toLowerCase();
    if (lang.startsWith('zh')) return 'zh';
    if (lang.startsWith('en')) return 'en';

    const text = String(userMessage || '');
    const zhCount = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    const enCount = (text.match(/[a-zA-Z]/g) || []).length;
    return zhCount >= enCount ? 'zh' : 'en';
}

function resolveDomainSystemPrompt({ domainMode = '', uiLanguage = '', userMessage = '' }) {
    const normalizedDomainMode = normalizeDomainMode(domainMode);
    if (!normalizedDomainMode) return null;

    const promptLanguage = resolvePromptLanguage(uiLanguage, userMessage);
    const promptPack = DOMAIN_SYSTEM_PROMPTS[normalizedDomainMode];
    const promptText = String(promptPack?.[promptLanguage] || promptPack?.en || '').trim();
    if (!promptText) return null;

    return {
        domainMode: normalizedDomainMode,
        promptLanguage,
        promptText
    };
}

function buildDomainInjectionInstruction(resolvedDomainPrompt) {
    if (!resolvedDomainPrompt?.promptText) return '';
    const mode = resolvedDomainPrompt.domainMode;
    const lang = resolvedDomainPrompt.promptLanguage === 'zh' ? 'zh' : 'en';
    const modeLabel = DOMAIN_LABELS[mode]?.[lang] || mode;
    const langLabel = lang === 'zh' ? '中文' : 'English';
    return [
        '[领域系统提示词]',
        `当前功能模式: ${modeLabel}`,
        `输出语言优先: ${langLabel}`,
        '在不违反安全、合规和真实性原则前提下，优先遵循以下专业规范：',
        resolvedDomainPrompt.promptText
    ].join('\n').trim();
}

function isInsufficientBalanceError(status, errorText = '') {
    const text = String(errorText || '').toLowerCase();
    if (![402, 403].includes(Number(status))) return false;
    return (
        text.includes('"code":30001') ||
        text.includes('code\\":30001') ||
        text.includes('insufficient') ||
        text.includes('account balance') ||
        text.includes('余额不足')
    );
}

function normalizeReasoningProfile(value = 'low') {
    const normalized = String(value || '').trim().toLowerCase();
    if (['low', 'medium', 'high', 'mixed'].includes(normalized)) return normalized;
    return 'low';
}

function normalizeResearchMode(value = 'off') {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'deep') return 'deep';
    if (normalized === 'fast') return 'fast';
    return 'off';
}

const REASONING_TEXT_KEYS = [
    'reasoning_content',
    'reasoning',
    'reasoning_text',
    'reasoningSummary',
    'reasoning_summary',
    'reasoning_summary_text',
    'thinking',
    'thought',
    'thoughts'
];

const REASONING_NESTED_KEYS = [
    'reasoning_details',
    'reasoningDetails',
    'summary',
    'summaries',
    'parts',
    'items'
];

function stringifyReasoningValue(value, seen = new Set()) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) {
        return value.map((item) => stringifyReasoningValue(item, seen)).filter(Boolean).join('');
    }
    if (typeof value !== 'object') return '';
    if (seen.has(value)) return '';
    seen.add(value);

    const type = String(value.type || '').toLowerCase();
    if (type.includes('encrypted')) return '';

    const pieces = [];
    for (const key of ['text', 'content', 'delta', 'value']) {
        if (typeof value[key] === 'string') {
            pieces.push(value[key]);
        }
    }
    for (const key of REASONING_TEXT_KEYS) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
            pieces.push(stringifyReasoningValue(value[key], seen));
        }
    }
    for (const key of REASONING_NESTED_KEYS) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
            pieces.push(stringifyReasoningValue(value[key], seen));
        }
    }

    return pieces.filter(Boolean).join('');
}

function extractReasoningTextFromPayload(...payloads) {
    const pieces = [];
    for (const payload of payloads) {
        if (!payload || typeof payload !== 'object') continue;

        for (const key of REASONING_TEXT_KEYS) {
            if (Object.prototype.hasOwnProperty.call(payload, key)) {
                pieces.push(stringifyReasoningValue(payload[key]));
            }
        }

        for (const key of REASONING_NESTED_KEYS) {
            if (Object.prototype.hasOwnProperty.call(payload, key)) {
                pieces.push(stringifyReasoningValue(payload[key]));
            }
        }
    }
    return pieces.filter(Boolean).join('');
}

function extractReasoningTextFromResponseEvent(event = {}) {
    const type = String(event?.type || '').toLowerCase();
    const itemType = String(event?.item?.type || event?.part?.type || event?.delta?.type || '').toLowerCase();
    if (!type.includes('reasoning') && !itemType.includes('reasoning')) return '';
    return (
        stringifyReasoningValue(event.delta) ||
        stringifyReasoningValue(event.text) ||
        stringifyReasoningValue(event.content) ||
        stringifyReasoningValue(event.summary) ||
        stringifyReasoningValue(event.part) ||
        stringifyReasoningValue(event.item) ||
        stringifyReasoningValue(event.output) ||
        extractReasoningTextFromPayload(event)
    );
}

function extractOutputTextFromResponseEvent(event = {}) {
    const type = String(event?.type || '').toLowerCase();
    if (!type.includes('output_text') && !type.includes('message.delta')) return '';
    return (
        (typeof event.delta === 'string' && event.delta) ||
        (typeof event.text === 'string' && event.text) ||
        (typeof event.content === 'string' && event.content) ||
        ''
    );
}

const THINKING_BUDGET_MODELS = new Set([
    'THUDM/GLM-Z1-9B-0414',
    'THUDM/GLM-4.1V-9B-Thinking'
]);

function isKimiK2ActualModel(modelName = '') {
    return /Kimi-K2\.(5|6)/i.test(String(modelName || ''));
}

function isQwen36A3BActualModel(modelName = '') {
    return String(modelName || '').trim().toLowerCase() === 'qwen/qwen3.6-35b-a3b';
}

function isKimiK25ActualModel(modelName = '') {
    return isKimiK2ActualModel(modelName);
}

function supportsThinkingBudgetModel(modelName = '') {
    return THINKING_BUDGET_MODELS.has(String(modelName || '').trim());
}

function resolveThinkingBudgetForModel(modelName = '', thinkingMode = false, thinkingBudget = 1024) {
    if (!supportsThinkingBudgetModel(modelName)) return null;

    // 对于默认思考模型，用极低budget模拟“快速模式”
    if (!thinkingMode) return 8;

    const parsed = parseInt(thinkingBudget, 10);
    if (isNaN(parsed) || parsed <= 0) return 1024;
    return Math.max(1, Math.min(parsed, 32768));
}

function resolveDeepSeekReasoningEffort(reasoningProfile = 'low') {
    const profile = normalizeReasoningProfile(reasoningProfile);
    return (profile === 'high' || profile === 'mixed') ? 'max' : 'high';
}

function resolveOpenAIReasoningEffort(reasoningProfile = 'low') {
    const profile = normalizeReasoningProfile(reasoningProfile);
    if (profile === 'high' || profile === 'mixed') return 'high';
    if (profile === 'medium') return 'medium';
    return 'low';
}

function resolveOpenAIChatReasoningEffort(modelName = '', thinkingMode = false, reasoningProfile = 'low') {
    const profile = normalizeReasoningProfile(reasoningProfile);
    const normalizedModel = String(modelName || '').trim().toLowerCase();

    if (normalizedModel.includes('gpt-5-pro')) {
        return 'high';
    }

    if (/^gpt-5\.1(?:$|-)/.test(normalizedModel)) {
        if (!thinkingMode) return 'none';
        if (profile === 'mixed') return 'high';
        if (profile === 'high') return 'high';
        if (profile === 'medium') return 'medium';
        return 'low';
    }

    if (/^gpt-(?:5\.[2-9]|[6-9](?:\.|$))/.test(normalizedModel)) {
        if (!thinkingMode) return 'none';
        if (profile === 'mixed') return 'xhigh';
        if (profile === 'high') return 'high';
        if (profile === 'medium') return 'medium';
        return 'low';
    }

    if (/^gpt-5(?:$|-)/.test(normalizedModel)) {
        if (!thinkingMode) return 'minimal';
        if (profile === 'mixed') return 'high';
        if (profile === 'high') return 'high';
        if (profile === 'medium') return 'medium';
        return 'low';
    }

    if (!thinkingMode) return null;
    return resolveOpenAIReasoningEffort(profile);
}

function resolveNewApiReasoningEffort(modelName = '', thinkingMode = false, reasoningProfile = 'low') {
    const profile = normalizeReasoningProfile(reasoningProfile);
    const normalizedModel = String(modelName || '').trim().toLowerCase();

    if (normalizedModel.startsWith('gpt-')) {
        return resolveOpenAIChatReasoningEffort(normalizedModel, thinkingMode, profile);
    }

    return thinkingMode ? resolveOpenAIReasoningEffort(profile) : null;
}

function resolveOpenRouterReasoningEffort(actualModel = '', reasoningProfile = 'low') {
    const profile = normalizeReasoningProfile(reasoningProfile);
    const normalizedModel = String(actualModel || '').trim().toLowerCase();

    if (normalizedModel.includes('gpt-oss')) {
        if (profile === 'high' || profile === 'mixed') return 'high';
        if (profile === 'medium') return 'medium';
        return 'low';
    }

    if (profile === 'mixed') return 'high';
    if (profile === 'high') return 'high';
    if (profile === 'medium') return 'medium';
    return 'low';
}

function applyNewApiModelParams(body, actualModel = '', thinkingMode = false, reasoningProfile = 'low') {
    if (!body || typeof body !== 'object') return;
    const effort = resolveNewApiReasoningEffort(actualModel, thinkingMode, reasoningProfile);
    if (effort) {
        body.reasoning_effort = effort;
        delete body.reasoning;
    } else {
        delete body.reasoning_effort;
        delete body.reasoning;
    }
}

function applyOpenRouterReasoningParams(body, actualModel = '', thinkingMode = false, reasoningProfile = 'low') {
    if (!body || typeof body !== 'object') return;

    const normalizedModel = String(actualModel || '').trim().toLowerCase();
    const isGptOss = normalizedModel.includes('gpt-oss');
    const isOpenRouterFree = normalizedModel === 'openrouter/free';

    if (!isGptOss && !isOpenRouterFree && !normalizedModel.includes('gemma')) {
        delete body.reasoning;
        return;
    }

    if (isGptOss) {
        if (thinkingMode) {
            body.reasoning = {
                effort: resolveOpenRouterReasoningEffort(actualModel, reasoningProfile),
                exclude: false
            };
        } else {
            body.reasoning = { exclude: true };
        }
        return;
    }

    if (thinkingMode) {
        body.reasoning = {
            effort: resolveOpenRouterReasoningEffort(actualModel, reasoningProfile),
            exclude: false
        };
    } else {
        delete body.reasoning;
    }
}

function applyDeepSeekV4ModeParams(body, thinkingMode = false, reasoningProfile = 'low') {
    if (!body || typeof body !== 'object') return;

    body.thinking = { type: thinkingMode ? 'enabled' : 'disabled' };
    if (thinkingMode) {
        body.reasoning_effort = resolveDeepSeekReasoningEffort(reasoningProfile);
        delete body.temperature;
        delete body.top_p;
        delete body.frequency_penalty;
        delete body.presence_penalty;
    } else {
        delete body.reasoning_effort;
    }
}

function buildSiliconflowFreeFallbackRequestBody({
    actualModel,
    messages,
    internetMode,
    thinkingMode,
    thinkingBudget,
    temperature,
    top_p,
    max_tokens
}) {
    const body = {
        model: actualModel,
        messages,
        max_tokens: parseInt(max_tokens, 10) || 2000,
        stream: true,
        temperature: parseFloat(temperature) || 0.7,
        top_p: parseFloat(top_p) || 0.9
    };

    const budget = resolveThinkingBudgetForModel(actualModel, !!thinkingMode, thinkingBudget);
    if (budget !== null) {
        body.thinking_budget = budget;
    }

    if (isQwen36A3BActualModel(actualModel)) {
        body.enable_thinking = false;
        body.thinking = { type: 'disabled' };
        delete body.reasoning_effort;
        delete body.thinking_budget;
    }

    // 硅基免费模型使用工具调用来联网，不走阿里云 enable_search
    if (internetMode) {
        body.tools = TOOL_DEFINITIONS;
        body.tool_choice = 'auto';
    }

    return body;
}



function normalizeAgentMode(value) {
    if (value === 'on' || value === true || value === 'true' || value === 1 || value === '1') {
        return 'on';
    }
    return 'off';
}

function normalizeQualityProfile(value) {
    return value === 'high' ? 'high' : AGENT_DEFAULT_QUALITY;
}

function normalizeAgentPolicy(value) {
    return value === AGENT_DEFAULT_POLICY ? value : AGENT_DEFAULT_POLICY;
}

function detectFreshnessNeed(message = '', internetMode = false) {
    const lower = String(message || '').toLowerCase();
    const keywordHit = FRESHNESS_KEYWORDS.some(k => lower.includes(k.toLowerCase()));
    // 开启联网仅代表“允许检索”，不等于“必须实时检索”
    return keywordHit || (internetMode && /(最新|实时|news|today|now|price|weather)/i.test(lower));
}

function shouldUseServerSideSearchContext({
    internetMode = false,
    routing = null,
    userMessage = '',
    enableResearchDebate = false,
    isMultimodalRequest = false
} = {}) {
    if (!internetMode || enableResearchDebate || isMultimodalRequest) return false;
    if (!routing || routing.provider !== 'deepseek') return false;

    const text = String(userMessage || '').trim();
    if (!text) return false;
    if (detectFreshnessNeed(text, internetMode)) return true;

    return /(?:了解|查(?:一下|下)?|搜索|搜一下|联网|资料|来源|数据|报告|论文|文献|官网|价格|成本|便宜|发布|下线|关闭|开启|如何|怎么|为什么|对比|现状|最新|实时|今天|现在|202[0-9]|latest|current|today|news|source|sources|data|docs?|paper|pricing|cost|cheap|compare|search|look\s*up|find|research|how|why)/i.test(text);
}

function buildServerSideSearchQuery(userMessage = '') {
    const text = String(userMessage || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';

    if (/(?:\bd\s*s\s*v\s*4\s*p\b|\bds\s*v4\s*pro\b|deep\s*sek|deepsek|deepseek\s*v4\s*pro)/i.test(text)) {
        const expanded = text
            .replace(/\bd\s*s\s*v\s*4\s*p\b/ig, 'DeepSeek V4 Pro')
            .replace(/\bds\s*v4\s*pro\b/ig, 'DeepSeek V4 Pro')
            .replace(/deep\s*sek/ig, 'DeepSeek')
            .replace(/deepsek/ig, 'DeepSeek');
        return `${expanded} DeepSeek V4 Pro cost optimization architecture MoE MLA FP8 inference cost`;
    }

    return text;
}

function detectImageGenerationNeed(message = '') {
    const text = String(message || '').toLowerCase();
    return /(?:画|绘制|生成|做|设计|出)(?:一张|张|个|幅)?[^，。,.!?]{0,40}(?:图|图片|海报|插画|头像|封面|壁纸|视觉|logo|图像)|(?:生图|文生图|图生图|draw|generate|create|make)[^.!?]{0,60}(?:image|picture|poster|illustration|wallpaper|logo)/i.test(text);
}

function isShortMemoryDeleteConfirmation(message = '') {
    const text = sanitizeMemoryContent(message).toLowerCase();
    return /^(删|删除|删掉|清理|可以|好|好的|行|对|是|帮我删|那就删|删了吧|delete|remove|yes|ok|okay)$/.test(text);
}

function isVagueMemoryDeleteReference(message = '') {
    const text = sanitizeMemoryContent(message).toLowerCase();
    if (!text || !/(?:删|删除|删掉|清理|移除|忘掉|忘记|delete|remove|forget|clear)/i.test(text)) return false;
    return /(?:这俩|那俩|这两|那两|两个|两条|几条|几个|这些|那些|它们|他们|上面|以上|刚才|刚刚|前面|都|全部|一起)/i.test(text)
        || /^(?:这|那|它|这条|那条)[\s\S]{0,16}(?:删|删除|删掉|清理|移除|忘掉|忘记|delete|remove|forget|clear)/i.test(text)
        || /(?:删|删除|删掉|清理|移除|忘掉|忘记|delete|remove|forget|clear)[\s\S]{0,16}(?:这|那|它|这些|那些|这俩|那俩|这两|那两|两个|两条|上面|以上|都|全部|一起)/i.test(text);
}

function isPluralMemoryDeleteReference(message = '') {
    const text = sanitizeMemoryContent(message).toLowerCase();
    return /(?:这俩|那俩|这两|那两|两个|两条|几条|几个|这些|那些|它们|他们|都|全部|一起|both|these|those|them|all)/i.test(text);
}

function scoreMemoryDeleteSegment(segment = '') {
    const text = String(segment || '');
    let score = 0;
    if (/(删|删除|删掉|清理|移除|忘掉|忘记|该删|delete|remove|forget|clean)/i.test(text)) score += 5;
    if (/(不合理|异常|错误|误会|不准|冲突|奇怪|提示词注入|攻击|不是正常|wrong|mistake|bad|incorrect|injection)/i.test(text)) score += 4;
    if (/(需要我|是否|要我|帮你|吗|should i|want me)/i.test(text)) score += 2;
    if (/(准确|正确|保留|不要删|别删|正常|keep|correct|accurate)/i.test(text)) score -= 5;
    return score;
}

function pickMemoryDeleteIdsFromAssistantText(text = '', userText = '') {
    const content = String(text || '');
    const allIds = extractMemoryIdsFromText(content);
    if (allIds.length === 0) return [];

    const scored = [];
    const segments = content
        .split(/[\n\r。！？!?；;]+/)
        .map((segment) => segment.trim())
        .filter(Boolean);
    for (const segment of segments) {
        const segmentIds = extractMemoryIdsFromText(segment);
        const leadingIdMatch = segment.match(/^\s*(?:[-*]\s*)?#\s*(\d+)/);
        const hasExplicitIdGroup = /(?:和|与|及|、|,|，)\s*#\s*\d+/.test(segment);
        const ids = leadingIdMatch && !hasExplicitIdGroup
            ? [Number(leadingIdMatch[1])]
            : segmentIds;
        if (ids.length === 0) continue;
        scored.push({
            ids,
            score: scoreMemoryDeleteSegment(segment),
            index: content.indexOf(segment)
        });
    }

    if (scored.length === 0) {
        return allIds.length === 1 ? allIds : [];
    }

    scored.sort((a, b) => b.score - a.score || b.index - a.index);
    const positive = scored.filter((item) => item.score > 0);
    if (positive.length === 0) {
        return allIds.length === 1 ? allIds : [];
    }

    const top = positive[0];
    if (isPluralMemoryDeleteReference(userText)) {
        return uniquePositiveMemoryIds(
            positive
                .sort((a, b) => b.index - a.index)
                .flatMap((item) => item.ids)
        );
    }

    if (top.ids.length > 1) {
        return uniquePositiveMemoryIds(
            positive
                .filter((item) => item.score >= top.score - 2)
                .sort((a, b) => b.index - a.index)
                .flatMap((item) => item.ids)
        );
    }

    return top.ids.length > 0 ? [top.ids[0]] : [];
}



function buildMemoryDeleteArgsFromIds(ids = [], reason = 'user_confirmed_recent_memory_delete') {
    const memoryIds = uniquePositiveMemoryIds(ids);
    if (memoryIds.length === 0) return null;
    return {
        ...(memoryIds.length > 1 ? { memory_ids: memoryIds } : {}),
        ...(memoryIds.length === 1 ? { memory_id: memoryIds[0] } : {}),
        reason
    };
}

function buildMemoryDeleteToolArgsFromConversation(userText = '', messages = []) {
    const clean = sanitizeMemoryContent(userText);
    if (!clean) return null;
    const hasDeleteVerb = /(?:删|删除|删掉|清理|移除|忘掉|忘记|不要记|别记|delete|remove|forget|clear)/i.test(clean);
    const explicitIds = extractMemoryIdsFromText(clean);
    if (hasDeleteVerb && explicitIds.length > 0) {
        return buildMemoryDeleteArgsFromIds(explicitIds, 'user_explicit_memory_ids');
    }

    const recentAssistantMessages = (Array.isArray(messages) ? messages : [])
        .slice(0, -1)
        .filter((message) => message?.role === 'assistant' && message.content)
        .slice(-4)
        .reverse();

    const isContextualConfirmation = isShortMemoryDeleteConfirmation(clean) || isVagueMemoryDeleteReference(clean);
    if (isContextualConfirmation) {
        for (const message of recentAssistantMessages) {
            const memoryIds = pickMemoryDeleteIdsFromAssistantText(message.content, clean);
            const args = buildMemoryDeleteArgsFromIds(memoryIds, 'user_confirmed_recent_memory_delete');
            if (args) return args;
        }
        return null;
    }

    const explicitArgs = normalizeDeleteMemoryToolArgs({ target: clean });
    if (hasDeleteVerb && explicitArgs?.target && clean.length > 1) {
        return explicitArgs;
    }

    return null;
}

function detectMemoryDeleteToolNeed(message = '', messages = []) {
    const text = String(message || '');
    if (!text.trim()) return false;
    return /(?:忘掉|忘记|删除|删掉|移除|清除|取消|不要记|别记|不需要记)[\s\S]{0,80}(?:记忆|长期记忆|你记得|关于我|#\s*\d+)/i.test(text)
        || /(?:delete|remove|forget|clear)[\s\S]{0,80}(?:memory|remember|about me|#\s*\d+)/i.test(text)
        || !!buildMemoryDeleteToolArgsFromConversation(text, messages);
}

function detectRiskLevel(message = '') {
    const lower = String(message || '').toLowerCase();
    return HIGH_RISK_KEYWORDS.some(k => lower.includes(k.toLowerCase())) ? 'high' : 'low';
}

function detectHighAccuracyNeed(message = '') {
    const lower = String(message || '').toLowerCase();
    return HIGH_ACCURACY_KEYWORDS.some(k => lower.includes(k.toLowerCase()));
}

function estimateUncertainty(complexityScore, freshnessNeed, riskLevel) {
    const base = 0.1 + (complexityScore * 0.35);
    const freshnessPenalty = freshnessNeed ? 0.2 : 0;
    const riskPenalty = riskLevel === 'high' ? 0.25 : 0;
    return Math.max(0, Math.min(base + freshnessPenalty + riskPenalty, 1));
}

function buildTaskFingerprint(userMessage, internetMode = false) {
    const safeMessage = String(userMessage || '');
    const complexity = evaluateComplexity(safeMessage);
    const complexityScore = Number(complexity?.score || 0);
    const freshnessNeed = detectFreshnessNeed(safeMessage, internetMode);
    const riskLevel = detectRiskLevel(safeMessage);
    const highAccuracyRequested = detectHighAccuracyNeed(safeMessage);
    const uncertainty = estimateUncertainty(complexityScore, freshnessNeed, riskLevel);

    return {
        complexityScore,
        freshnessNeed,
        riskLevel,
        uncertainty,
        highAccuracyRequested
    };
}

function selectAgentSet(taskFingerprint, policy = AGENT_DEFAULT_POLICY) {
    if (policy !== AGENT_DEFAULT_POLICY) {
        return ['synthesizer'];
    }

    const {
        complexityScore = 0,
        freshnessNeed = false,
        riskLevel = 'low',
        uncertainty = 0,
        highAccuracyRequested = false
    } = taskFingerprint || {};

    let selected = ['synthesizer'];
    if (freshnessNeed || complexityScore >= 0.55) {
        selected = ['planner', 'researcher', 'synthesizer'];
    } else if (complexityScore >= 0.25 && complexityScore <= 0.55 && !freshnessNeed) {
        selected = ['planner', 'synthesizer'];
    }

    if (riskLevel === 'high' || uncertainty > 0.35 || highAccuracyRequested) {
        selected = [...AGENT_ROLES];
    }

    return selected;
}

function emitAgentEvent(res, payload) {
    if (!res || !payload) return;
    if (process.env.AGENT_DEBUG === '1') {
        const role = payload.role ? ` role=${payload.role}` : '';
        const status = payload.status ? ` status=${payload.status}` : '';
        console.log(` agent_event type=${payload.type}${role}${status}`);
    }
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function summarizePlannerPlan(userMessage, fingerprint, selectedAgents) {
    const text = String(userMessage || '').trim();
    const summary = text.length > 80 ? `${text.slice(0, 80)}...` : text;
    const goals = [
        '澄清用户目标与约束',
        fingerprint.freshnessNeed ? '提取需要联网核验的关键信息' : '提取关键推理步骤',
        '生成可验证的最终答案结构'
    ];

    return {
        summary,
        goals,
        selectedAgents
    };
}

function runPlanner({ userMessage, fingerprint, selectedAgents }) {
    return summarizePlannerPlan(userMessage, fingerprint, selectedAgents);
}

function runResearcher({ userMessage, fingerprint }) {
    const baseQuery = String(userMessage || '').replace(/\s+/g, ' ').trim();
    const hints = [];
    if (baseQuery) {
        hints.push(baseQuery.length > 80 ? `${baseQuery.slice(0, 80)} latest` : baseQuery);
    }
    if (fingerprint?.freshnessNeed) {
        hints.push(`${baseQuery} official source`);
    }
    return {
        shouldSearch: !!fingerprint?.freshnessNeed,
        queryHints: hints.slice(0, 3)
    };
}

function runSynthesizer() {
    return {
        mode: 'streaming',
        delegated: true
    };
}

function runVerifier({ qualityProfile, content, sources, fingerprint }) {
    return applyQualityGate({ qualityProfile, content, sources, fingerprint });
}

function scoreSourceQuality(sources = []) {
    if (!Array.isArray(sources) || sources.length === 0) return 0;

    const lowQualityPatterns = ['aqi.in', 'weather25', 'unknown'];
    let total = 0;
    for (const src of sources) {
        const url = String(src?.url || '');
        const title = String(src?.title || '');
        let score = 0.5;
        if (url.startsWith('https://')) score += 0.2;
        if (url && !lowQualityPatterns.some(p => url.includes(p))) score += 0.2;
        if (title && title !== '未知标题') score += 0.1;
        total += Math.min(score, 1);
    }
    return Math.max(0, Math.min(total / sources.length, 1));
}

function estimateClaimCoverage(content = '', sources = [], freshnessNeed = false) {
    const text = String(content || '').trim();
    if (!text) return 0;

    const claims = text.split(/[\n。！？.!?;；]/g).map(s => s.trim()).filter(s => s.length >= 12);
    if (claims.length === 0) return 1;

    const citationHits = (text.match(/\[\d+\]/g) || []).length;
    let coveredClaims = citationHits;
    if (coveredClaims === 0 && Array.isArray(sources) && sources.length > 0) {
        // 未显式角标时，按“已参考来源但未编号”处理，避免过度误判
        coveredClaims = Math.ceil(Math.min(claims.length, claims.length * 0.85));
    }

    if (!freshnessNeed && (!sources || sources.length === 0)) {
        return 1;
    }

    return Math.max(0, Math.min(coveredClaims / claims.length, 1));
}

function detectSimpleContradictions(content = '') {
    const text = String(content || '').toLowerCase();
    if (!text) return 0;
    if (text.includes('自相矛盾') || text.includes('contradict')) {
        return 1;
    }
    return 0;
}

function applyQualityGate({ qualityProfile, content, sources, fingerprint }) {
    const normalizedProfile = normalizeQualityProfile(qualityProfile);
    const freshnessNeed = !!fingerprint?.freshnessNeed;
    const claimCoverage = estimateClaimCoverage(content, sources, freshnessNeed);
    const contradictionCount = detectSimpleContradictions(content);
    const sourceQualityScore = scoreSourceQuality(sources);

    const thresholds = {
        claimCoverage: normalizedProfile === 'high' ? 0.8 : 0.65,
        sourceQuality: normalizedProfile === 'high' ? 0.55 : 0.45
    };

    const sourceGatePass = freshnessNeed
        ? sourceQualityScore >= thresholds.sourceQuality
        : true;

    const pass = (
        claimCoverage >= thresholds.claimCoverage &&
        contradictionCount === 0 &&
        sourceGatePass
    );

    return {
        pass,
        metrics: {
            claimCoverage: Number(claimCoverage.toFixed(3)),
            contradictionCount,
            sourceQualityScore: Number(sourceQualityScore.toFixed(3))
        },
        thresholds
    };
}

function buildConservativeFallbackNote(fingerprint) {
    return '';
}

function runAgentOrchestrator({ res, userMessage, internetMode, agentMode, agentPolicy, qualityProfile }) {
    const normalizedMode = normalizeAgentMode(agentMode);
    if (normalizedMode !== 'on') {
        return {
            enabled: false,
            agentMode: 'off',
            agentPolicy: normalizeAgentPolicy(agentPolicy),
            qualityProfile: normalizeQualityProfile(qualityProfile)
        };
    }

    const fingerprint = buildTaskFingerprint(userMessage, internetMode);
    const normalizedPolicy = normalizeAgentPolicy(agentPolicy);
    const normalizedQuality = normalizeQualityProfile(qualityProfile);
    const selectedAgents = selectAgentSet(fingerprint, normalizedPolicy);
    const plannerPlan = runPlanner({ userMessage, fingerprint, selectedAgents });
    const researcherPlan = runResearcher({ userMessage, fingerprint });
    const synthesizerPlan = runSynthesizer();

    emitAgentEvent(res, {
        type: 'agent_status',
        role: 'master',
        status: 'start',
        detail: '开始任务指纹分析'
    });

    emitAgentEvent(res, {
        type: 'agent_plan',
        policy: normalizedPolicy,
        qualityProfile: normalizedQuality,
        selectedAgents,
        maxRetries: AGENT_MAX_RETRIES,
        fingerprint,
        plan: plannerPlan
    });

    if (selectedAgents.includes('planner')) {
        emitAgentEvent(res, {
            type: 'agent_status',
            role: 'planner',
            status: 'start',
            detail: '开始任务拆解'
        });
        emitAgentEvent(res, {
            type: 'agent_status',
            role: 'planner',
            status: 'done',
            detail: '任务拆解完成'
        });
    }

    if (selectedAgents.includes('researcher')) {
        emitAgentEvent(res, {
            type: 'agent_status',
            role: 'researcher',
            status: 'start',
            detail: researcherPlan.queryHints?.[0]
                ? `等待检索任务: ${researcherPlan.queryHints[0]}`
                : '等待检索任务'
        });
    }

    if (selectedAgents.includes('synthesizer')) {
        emitAgentEvent(res, {
            type: 'agent_status',
            role: 'synthesizer',
            status: 'start',
            detail: synthesizerPlan.delegated ? '准备生成回答（流式）' : '准备生成回答'
        });
    }

    return {
        enabled: true,
        agentMode: 'on',
        agentPolicy: normalizedPolicy,
        qualityProfile: normalizedQuality,
        selectedAgents,
        fingerprint,
        retriesUsed: 0
    };
}


// [已删除] aiDecideWebSearch - 已被原生Function Calling替代
// 现在使用 callAPIWithTools + TOOL_DEFINITIONS 实现工具调用


/**
 * 使用AI生成智能搜索查询 (保留向后兼容)
 * AI根据用户问题自主决定应该搜索什么内容
 * @deprecated 推荐使用 aiDecideWebSearch 代替
 * @param {string} userMessage - 用户的原始问题
 * @param {Array} conversationHistory - 对话历史（可选）
 * @returns {Promise<string>} 优化后的搜索查询
 */



/**
 * 根据模型类型决定Tavily搜索深度
 * @param {string} modelName - 实际使用的模型名称
 * @param {boolean} isThinkingMode - 是否开启思考模式
 * @returns {string} 'ultra-fast' | 'fast' | 'basic'
 */
function getTavilySearchDepth(modelName, isThinkingMode = false) {
    // 思考模式固定使用 basic
    if (isThinkingMode || modelName.includes('Thinking')) {
        return 'basic';
    }
    // 快速/轻量模型优先 ultra-fast
    if (modelName.includes('flash') || modelName.includes('8B') || modelName.includes('Instruct')) {
        return 'ultra-fast';
    }
    // 默认使用基础搜索
    return 'basic';
}

/**
 * 执行网页搜索 (使用Tavily API)
 * Tavily是专为AI代理设计的搜索API，提供高质量、实时的搜索结果
 * @param {string} query - 搜索查询
 * @param {number} maxResults - 最大结果数量
 * @param {string} searchDepth - 搜索深度 'ultra-fast'|'fast'|'basic'
 * @returns {Promise<Array>} 搜索结果数组
 */
async function performWebSearch(query, maxResults = 5, searchDepth = 'basic') {
    return new Promise((resolve) => {
        try {
            if (!TAVILY_API_KEY) {
                console.error(' 缺少 TAVILY_API_KEY，跳过联网搜索');
                resolve({ results: [], images: [] });
                return;
            }
            console.log(` 执行Tavily网页搜索: "${query}" (深度: ${searchDepth})`);

            // 构建请求体
            const requestBody = JSON.stringify({
                api_key: TAVILY_API_KEY,
                query: query,
                search_depth: searchDepth,
                include_answer: true,          // 包含AI生成的摘要答案
                include_raw_content: false,    // 不需要原始HTML内容
                max_results: Math.max(1, parseInt(maxResults, 10) || 5),
                include_images: true,          // 开启图片搜索
                include_favicon: true,         // 包含网站图标
                topic: 'general'               // 通用搜索
            });

            // 解析URL
            const urlParts = new URL(TAVILY_API_URL);

            const options = {
                hostname: urlParts.hostname,
                port: 443,
                path: urlParts.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(requestBody)
                }
            };

            const req = https.request(options, (res) => {
                let data = '';

                res.on('data', (chunk) => {
                    data += chunk;
                });

                res.on('end', () => {
                    try {
                        const result = JSON.parse(data);
                        const searchResults = [];

                        // 检查API错误
                        if (result.error) {
                            console.error(' Tavily API错误:', result.error);
                            resolve([]);
                            return;
                        }

                        // 如果有AI生成的答案摘要，添加到结果中
                        if (result.answer) {
                            searchResults.push({
                                title: 'AI 搜索摘要',
                                snippet: result.answer,
                                url: '',
                                source: 'Tavily AI'
                            });
                        }

                        // 提取搜索结果
                        if (result.results && Array.isArray(result.results)) {
                            result.results.forEach(item => {
                                searchResults.push({
                                    title: item.title || '未知标题',
                                    snippet: item.content || '',
                                    url: item.url || '',
                                    favicon: item.favicon || '',  // 包含favicon
                                    source: 'Tavily',
                                    score: item.score  // 相关性评分
                                });
                            });
                        }

                        // 提取搜索图片
                        const images = result.images || [];

                        console.log(` Tavily搜索完成，获得 ${searchResults.length} 条结果, ${images.length} 张图片 (响应时间: ${result.responseTime || 'N/A'}s)`);
                        resolve({ results: searchResults, images: images });
                    } catch (parseError) {
                        console.error(' 解析Tavily搜索结果失败:', parseError);
                        console.error('原始响应:', data);
                        resolve([]);
                    }
                });
            });

            req.on('error', (err) => {
                console.error(' Tavily网页搜索请求失败:', err);
                resolve({ results: [], images: [] });
            });

            // 设置超时
            req.setTimeout(15000, () => {
                console.error(' Tavily搜索请求超时');
                req.destroy();
                resolve({ results: [], images: [] });
            });

            // 发送请求
            req.write(requestBody);
            req.end();
        } catch (error) {
            console.error(' Tavily网页搜索异常:', error);
            resolve({ results: [], images: [] });
        }
    });
}

/**
 * 验证单个图片URL是否可访问
 * @param {string} imageUrl - 图片URL
 * @param {number} timeout - 超时时间(ms)
 * @returns {Promise<boolean>} 是否可访问
 */
async function validateImageUrl(imageUrl, timeout = IMAGE_URL_HEAD_TIMEOUT_MS) {
    if (!imageUrl || typeof imageUrl !== 'string') return false;
    try {
        return await fetchSafeImageHead(imageUrl, timeout);
    } catch (error) {
        console.warn(` 图片URL验证已拒绝: ${error.message}`);
        return false;
    }
}

/**
 * 并行验证多个图片URL，过滤出有效的
 * @param {Array<string>} imageUrls - 图片URL数组
 * @param {number} maxConcurrent - 最大并发数
 * @param {number} totalTimeout - 总超时时间(ms)
 * @returns {Promise<Array<string>>} 有效的图片URL数组
 */
async function filterValidImages(imageUrls, maxConcurrent = 5, totalTimeout = 3000) {
    if (!imageUrls || imageUrls.length === 0) return [];

    console.log(` 验证 ${imageUrls.length} 张图片URL...`);

    // 只验证前N张，避免太慢
    const urlsToCheck = imageUrls.slice(0, maxConcurrent);

    // 使用Promise.allSettled并行验证，带总超时
    const timeoutPromise = new Promise((resolve) => {
        setTimeout(() => resolve([]), totalTimeout);
    });

    const validationPromise = Promise.all(
        urlsToCheck.map(async (url) => {
            const isValid = await validateImageUrl(url);
            return { url, isValid };
        })
    );

    const results = await Promise.race([validationPromise, timeoutPromise]);

    // 如果超时返回空数组
    if (!Array.isArray(results) || results.length === 0) {
        console.log(` 图片验证超时，跳过图片`);
        return [];
    }

    const validUrls = results.filter(r => r.isValid).map(r => r.url);
    console.log(` 图片验证完成: ${validUrls.length}/${urlsToCheck.length} 有效`);

    return validUrls;
}

/**
 * 格式化搜索结果为提示词（带角标引用指引）
 * @param {Array} results - 搜索结果
 * @param {string} query - 原始查询
 * @returns {string} 格式化的搜索结果文本
 */
function formatSearchResults(searchData, query) {
    // 兼容旧格式和新格式
    const results = searchData.results || searchData;
    const images = searchData.images || [];

    if (!results || results.length === 0) {
        return '';
    }

    let formatted = `\n\n[网页搜索结果] 关于"${query}"：\n\n`;

    // 跳过AI摘要，只使用实际网页来源
    const webResults = results.filter(r => r.url && r.url.trim() !== '');

    webResults.forEach((result, index) => {
        const citationNum = index + 1;
        formatted += `[${citationNum}] ${result.title}\n`;
        formatted += `   ${result.snippet}\n`;
        formatted += `   来源: ${result.url}\n\n`;
    });

    // 如果有图片，添加图片信息
    if (images.length > 0) {
        formatted += `\n[搜索相关图片] 以下是与查询相关的图片URL，可在回复中使用 ![描述](url) 格式引用：\n`;
        images.slice(0, 5).forEach((imgUrl, index) => {
            formatted += `图片${index + 1}: ${imgUrl}\n`;
        });
        formatted += `\n`;
    }

    // 指示模型使用角标引用
    formatted += `\n重要指示：
1. 请基于以上搜索结果回答用户问题
2. 在回答中使用角标标记信息来源，格式为 [1]、[2] 等
3. 例如："根据最新数据，该产品售价为999元[1]。"
4. 每个角标对应上方的搜索结果编号
5. 如果有相关图片且对回答有帮助，可以使用 ![描述](图片URL) 格式插入图片\n`;

    return formatted;
}

/**
 * 新增：提取用于SSE传输的来源信息
 * @param {Array} results - 搜索结果
 * @returns {Array} 简化的来源数组
 */
function extractSourcesForSSE(results) {
    if (!results || results.length === 0) return [];

    // 跳过AI摘要，只返回实际网页来源
    return results
        .filter(r => r.url && r.url.trim() !== '')
        .map((r) => ({
            title: r.title || '未知标题',
            url: r.url,
            favicon: r.favicon || '',
            site_name: r.url ? new URL(r.url).hostname.replace('www.', '') : '',
            snippet: r.snippet || '',
            provider: 'tavily',
            sourceKind: 'web',
            markerType: 'numeric',
            label: 'Tavily'
        }));
}

function alphaMarkerFromIndex(index) {
    let current = Number(index || 1);
    let marker = '';
    while (current > 0) {
        const remainder = (current - 1) % 26;
        marker = String.fromCharCode(65 + remainder) + marker;
        current = Math.floor((current - 1) / 26);
    }
    return marker || 'A';
}

function getSourceKind(source = {}) {
    if (source.sourceKind) return source.sourceKind;
    if (source.provider === 'yahoo_finance') return 'finance';
    return 'web';
}

function getSourceIdentityKey(source = {}) {
    return [
        String(source.provider || ''),
        String(source.url || ''),
        String(source.title || ''),
        String(source.symbol || ''),
        String(source.range || ''),
        String(source.interval || '')
    ].join('|');
}

function appendAnnotatedSources(existingSources = [], incomingSources = []) {
    const merged = Array.isArray(existingSources) ? existingSources.map((source) => ({ ...source })) : [];
    const seen = new Set(merged.map(getSourceIdentityKey));

    let webCounter = merged.filter((source) => getSourceKind(source) === 'web').length;
    let financeCounter = merged.filter((source) => getSourceKind(source) === 'finance').length;
    const newlyAdded = [];

    for (const rawSource of (Array.isArray(incomingSources) ? incomingSources : [])) {
        if (!rawSource || typeof rawSource !== 'object') continue;
        const source = { ...rawSource };
        const identityKey = getSourceIdentityKey(source);
        if (seen.has(identityKey)) continue;
        seen.add(identityKey);

        const sourceKind = getSourceKind(source);
        source.sourceKind = sourceKind;
        source.provider = source.provider || (sourceKind === 'finance' ? 'yahoo_finance' : 'tavily');
        source.label = source.label || (sourceKind === 'finance' ? 'Yahoo Finance' : 'Tavily');

        if (sourceKind === 'finance') {
            financeCounter += 1;
            source.markerType = 'alpha';
            source.marker = source.marker || alphaMarkerFromIndex(financeCounter);
            source.index = source.index || financeCounter;
        } else {
            webCounter += 1;
            source.markerType = 'numeric';
            source.marker = source.marker || String(webCounter);
            source.index = source.index || webCounter;
        }

        merged.push(source);
        newlyAdded.push(source);
    }

    return { merged, newlyAdded };
}

function emitSourcesEvent(res, sources = []) {
    if (!res || !Array.isArray(sources) || sources.length === 0) return;
    res.write(`data: ${JSON.stringify({ type: 'sources', sources })}\n\n`);
}

function buildFinanceSourceForSSE(financeResult = {}) {
    const resolvedSymbol = financeResult.resolvedSymbol || financeResult.symbol || '';
    if (!resolvedSymbol) return [];

    const titleBase = financeResult.meta?.shortName || financeResult.meta?.longName || resolvedSymbol;
    return [{
        title: `${titleBase} (${resolvedSymbol})`,
        url: `https://finance.yahoo.com/quote/${encodeURIComponent(resolvedSymbol)}`,
        favicon: '',
        site_name: 'finance.yahoo.com',
        provider: 'yahoo_finance',
        sourceKind: 'finance',
        markerType: 'alpha',
        label: 'Yahoo Finance',
        symbol: resolvedSymbol,
        range: financeResult.range || FINANCE_DEFAULT_RANGE,
        interval: financeResult.interval || FINANCE_DEFAULT_INTERVAL,
        delayed: !!financeResult.delayed
    }];
}

function buildToolResultForLLM({ toolName, result, sources = [], args = {} }) {
    if (toolName === 'web_search') {
        return {
            query: args.query || '',
            results: (result?.results || []).map((item) => ({
                title: item.title || '',
                url: item.url || '',
                snippet: item.snippet || ''
            })),
            images: result?.images || [],
            citations: sources.map((source) => ({
                marker: source.marker,
                title: source.title,
                url: source.url,
                snippet: source.snippet || ''
            })),
            citation_instruction: 'When citing these web sources, use numeric markers exactly like [1], [2], [3].'
        };
    }

    if (toolName === 'finance_quote') {
        const financeSource = Array.isArray(sources) ? sources[0] : null;
        return {
            ...result,
            citation_marker: financeSource?.marker || 'A',
            citation_label: financeSource?.label || 'Yahoo Finance',
            citation_instruction: `When citing this market data, use the alpha marker [${financeSource?.marker || 'A'}].`
        };
    }

    if (toolName === 'generate_image') {
        const imageCount = Array.isArray(result?.images)
            ? result.images.filter((image) => String(image?.url || '').trim().startsWith(GENERATED_IMAGE_PUBLIC_PREFIX + '/')).length
            : 0;
        return {
            provider: result?.provider || 'siliconflow',
            model: result?.model || KOLORS_IMAGE_MODEL,
            prompt: result?.prompt || args.prompt || '',
            parameters: result?.parameters || {},
            image_count: imageCount,
            displayed_by_server: imageCount > 0,
            display_instruction: 'The server already displayed the generated image to the user. Do not output Markdown images, image URLs, provider URLs, or base64. Reply with only a brief natural-language note.'
        };
    }

    if (toolName === 'delete_memory') {
        return {
            success: !!result?.success,
            deleted_count: Number(result?.deletedCount || 0),
            deleted_memory: result?.deletedMemory || null,
            deleted_memories: Array.isArray(result?.deletedMemories) ? result.deletedMemories : [],
            matched_by: result?.matchedBy || '',
            message: result?.message || '',
            reply_instruction: result?.success
                ? 'Tell the user briefly that the requested memory was deleted. Do not repeat or rely on the deleted memory afterward.'
                : 'Tell the user briefly that the memory was not found or could not be deleted, and ask for the exact memory if needed.'
        };
    }

    return result;
}

function sanitizeImageWaitingLine(text = '') {
    let line = String(text || '')
        .replace(/```[\s\S]*?```/g, '')
        .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
        .replace(/https?:\/\/\S+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    line = line.replace(/^["“'「『]+|["”'」』。.!！]+$/g, '').trim();
    if (!line) return '';
    const firstSentence = line.match(/^(.{6,90}?[。.!！?？])/);
    if (firstSentence) line = firstSentence[1].trim();
    if (line.length > 64) line = `${line.slice(0, 64).trim()}。`;
    if (!/[。.!！?？]$/.test(line)) line += '。';
    return line;
}

async function buildImageWaitingLineFromUserPrompt(userPrompt = '') {
    const prompt = String(userPrompt || '').trim().slice(0, 600);
    if (!prompt || !isRuntimeConfiguredModel(IMAGE_WAITING_LINE_MODEL_ID)) {
        return '正在生成图片中，我会先把画面细节稳稳铺好。';
    }

    try {
        const result = await callResearchModelNonStream({
            modelId: IMAGE_WAITING_LINE_MODEL_ID,
            thinkingMode: false,
            reasoningProfile: 'low',
            maxTokens: 512,
            timeoutMs: IMAGE_WAITING_LINE_TIMEOUT_MS,
            messages: [
                {
                    role: 'system',
                    content: [
                        '你是 RAI 的图片生成等待文案助手。',
                        '只根据用户这一轮图片请求，写一句安定、克制、贴近画面主题的状态文案。',
                        '要求：使用用户同语种；18 到 36 个中文字符或 8 到 18 个英文词；不要夸张、不要卖萌、不要表情、不要 Markdown、不要引号。',
                        '不要提模型、API、token、失败、等待时间；不要承诺一定完美。只输出这一句话。'
                    ].join('\n')
                },
                {
                    role: 'user',
                    content: `用户这一轮图片请求：${prompt}`
                }
            ]
        });
        return sanitizeImageWaitingLine(result?.content) || '正在生成图片中，我会先把画面细节稳稳铺好。';
    } catch (error) {
        appendRaiRuntimeReport({
            level: '报错',
            tag: 'image_waiting_line_failed',
            message: error.message,
            context: {
                modelId: IMAGE_WAITING_LINE_MODEL_ID
            }
        });
        return '正在生成图片中，我会先把画面细节稳稳铺好。';
    }
}

/**
 * 带工具定义的API调用 (非流式)
 * 用于工具调用决策阶段
 * @param {Array} messages - 消息数组
 * @param {string} model - 模型名称
 * @param {object} providerConfig - API提供商配置
 * @param {Array} tools - 工具定义数组
 * @returns {Promise<object>} { finish_reason, tool_calls, content }
 */
async function callAPIWithTools(messages, model, providerConfig, tools) {
    console.log(` 调用API (带工具): model=${model}, tools=${tools.length}个`);

    const requestBody = {
        model: model,
        messages: messages,
        tools: tools,
        tool_choice: "auto",
        stream: false,
        max_tokens: 1000
    };

    return new Promise((resolve, reject) => {
        const urlParts = new URL(providerConfig.baseURL);

        const requestLib = urlParts.protocol === 'https:' ? https : require('http');
        const options = {
            hostname: urlParts.hostname,
            port: urlParts.port || (urlParts.protocol === 'https:' ? 443 : 80),
            path: urlParts.pathname + urlParts.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${providerConfig.apiKey}`
            }
        };

        const req = requestLib.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const result = JSON.parse(data);

                    if (result.error) {
                        console.error(' 工具调用API错误:', result.error);
                        resolve({ finish_reason: 'error', tool_calls: null, content: null });
                        return;
                    }

                    const choice = result.choices?.[0];
                    const response = {
                        finish_reason: choice?.finish_reason,
                        tool_calls: choice?.message?.tool_calls,
                        content: choice?.message?.content,
                        message: choice?.message
                    };

                    console.log(` 工具调用API响应: finish_reason=${response.finish_reason}, has_tool_calls=${!!response.tool_calls}`);
                    resolve(response);
                } catch (e) {
                    console.error(' 解析工具调用响应失败:', e);
                    resolve({ finish_reason: 'error', tool_calls: null, content: null });
                }
            });
        });

        req.on('error', (err) => {
            console.error(' 工具调用请求失败:', err);
            resolve({ finish_reason: 'error', tool_calls: null, content: null });
        });

        req.setTimeout(15000, () => {
            console.warn(' 工具调用请求超时');
            req.destroy();
            resolve({ finish_reason: 'timeout', tool_calls: null, content: null });
        });

        req.write(JSON.stringify(requestBody));
        req.end();
    });
}

function dedupeSources(sources = []) {
    if (!Array.isArray(sources) || sources.length === 0) return [];
    const seen = new Set();
    const deduped = [];
    for (const source of sources) {
        const key = getSourceIdentityKey(source);
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(source);
    }
    return deduped;
}

function buildHistoryContext(messages = [], maxCount = 6) {
    return (messages || [])
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
        .slice(-maxCount)
        .map((m) => {
            const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
            return `${m.role === 'user' ? '用户' : '助手'}: ${content}`;
        })
        .join('\n');
}

function createSearchBudget(totalLimit = 8, perTaskLimit = 2) {
    return {
        totalLimit,
        perTaskLimit,
        totalUsed: 0,
        perTaskUsed: {},
        cache: new Map()
    };
}

function normalizeToolCalls(toolCalls = []) {
    const normalized = [];
    for (const toolCall of toolCalls) {
        if (!toolCall || toolCall.type !== 'function' || !toolCall.function?.name) continue;
        let args = {};
        try {
            args = JSON.parse(toolCall.function.arguments || '{}');
        } catch (e) {
            args = {};
        }
        const toolName = String(toolCall.function.name || '').trim();
        if (toolName === 'web_search') {
            const query = String(args.query || '').trim();
            if (!query) continue;
            normalized.push({
                id: toolCall.id || `tool_${Date.now()}_${normalized.length}`,
                type: 'function',
                function: {
                    name: toolName,
                    arguments: JSON.stringify({ query })
                },
                _args: { query }
            });
            continue;
        }

        if (toolName === 'generate_image') {
            let normalizedArgs;
            try {
                normalizedArgs = normalizeKolorsImageArgs(args);
            } catch (error) {
                console.warn(` 跳过无效 generate_image 参数: ${error.message}`);
                continue;
            }
            normalized.push({
                id: toolCall.id || `tool_${Date.now()}_${normalized.length}`,
                type: 'function',
                function: {
                    name: toolName,
                    arguments: JSON.stringify(normalizedArgs)
                },
                _args: normalizedArgs
            });
            continue;
        }

        if (toolName === 'finance_quote') {
            const rawSymbol = String(args.symbol || args.ticker || '').trim();
            if (!rawSymbol) continue;
            let normalizedSymbol;
            try {
                normalizedSymbol = resolveFinanceSymbol(rawSymbol);
            } catch (error) {
                console.warn(` 跳过无效 finance_quote symbol: ${rawSymbol}`);
                continue;
            }

            const normalizedArgs = {
                symbol: normalizedSymbol,
                range: normalizeFinanceRange(args.range || FINANCE_DEFAULT_RANGE),
                interval: normalizeFinanceInterval(args.interval || FINANCE_DEFAULT_INTERVAL)
            };
            normalized.push({
                id: toolCall.id || `tool_${Date.now()}_${normalized.length}`,
                type: 'function',
                function: {
                    name: toolName,
                    arguments: JSON.stringify(normalizedArgs)
                },
                _args: normalizedArgs
            });
            continue;
        }

        if (toolName === 'delete_memory') {
            const normalizedArgs = normalizeDeleteMemoryToolArgs(args);
            if (!normalizedArgs) continue;
            normalized.push({
                id: toolCall.id || `tool_${Date.now()}_${normalized.length}`,
                type: 'function',
                function: {
                    name: toolName,
                    arguments: JSON.stringify(normalizedArgs)
                },
                _args: normalizedArgs
            });
        }
    }
    return normalized;
}

async function executeSearchWithBudget({
    query,
    taskKey,
    searchBudget,
    res,
    actualModel,
    thinkingMode
}) {
    const normalizedQuery = String(query || '').trim();
    const cacheKey = normalizedQuery.toLowerCase();
    const safeTaskKey = taskKey || 'global';

    if (!searchBudget.perTaskUsed[safeTaskKey]) {
        searchBudget.perTaskUsed[safeTaskKey] = 0;
    }

    const emitSearchStatus = (payload) => {
        if (!res) return;
        res.write(`data: ${JSON.stringify({
            type: 'search_status',
            ...payload,
            taskId: safeTaskKey
        })}\n\n`);
    };

    if (searchBudget.cache.has(cacheKey)) {
        const cached = searchBudget.cache.get(cacheKey);
        emitSearchStatus({
            status: 'complete',
            query: normalizedQuery,
            resultCount: cached.results?.length || 0,
            message: `缓存命中: ${normalizedQuery}`
        });
        return { result: cached, cached: true, searchCountInc: 0 };
    }

    if (searchBudget.totalUsed >= searchBudget.totalLimit || searchBudget.perTaskUsed[safeTaskKey] >= searchBudget.perTaskLimit) {
        emitSearchStatus({
            status: 'no_results',
            query: normalizedQuery,
            message: '检索预算已用尽，跳过搜索'
        });
        return {
            result: {
                results: [],
                images: [],
                budget_exceeded: true,
                message: 'search budget exceeded'
            },
            cached: false,
            searchCountInc: 0
        };
    }

    emitSearchStatus({
        status: 'searching',
        query: normalizedQuery,
        message: `正在搜索: "${normalizedQuery}"`
    });

    searchBudget.totalUsed += 1;
    searchBudget.perTaskUsed[safeTaskKey] += 1;

    const searchDepth = getTavilySearchDepth(actualModel, thinkingMode);
    const searchResult = await TOOL_EXECUTORS.web_search({ query: normalizedQuery }, searchDepth);
    const normalizedResult = searchResult && searchResult.results
        ? searchResult
        : { results: Array.isArray(searchResult) ? searchResult : [], images: [] };

    searchBudget.cache.set(cacheKey, normalizedResult);
    emitSearchStatus({
        status: 'complete',
        query: normalizedQuery,
        resultCount: normalizedResult.results?.length || 0,
        message: `找到 ${normalizedResult.results?.length || 0} 条结果`
    });

    return {
        result: normalizedResult,
        cached: false,
        searchCountInc: 1
    };
}

async function executeNormalizedToolCall({
    toolCall,
    searchBudget,
    taskKey,
    res,
    actualModel,
    thinkingMode,
    userId = null,
    sessionId = null
}) {
    const toolName = toolCall?.function?.name;
    const args = toolCall?._args || {};

    if (toolName === 'web_search') {
        const searchResult = await executeSearchWithBudget({
            query: args.query,
            taskKey,
            searchBudget,
            res,
            actualModel,
            thinkingMode
        });
        return {
            result: searchResult.result,
            sources: extractSourcesForSSE(searchResult.result?.results || []),
            searchCountInc: searchResult.searchCountInc
        };
    }

    if (toolName === 'finance_quote') {
        const financeResult = await TOOL_EXECUTORS.finance_quote(args);
        return {
            result: financeResult,
            sources: buildFinanceSourceForSSE(financeResult),
            searchCountInc: 0
        };
    }

    if (toolName === 'generate_image') {
        const imageResult = await TOOL_EXECUTORS.generate_image(args);
        return {
            result: imageResult,
            sources: [],
            searchCountInc: 0
        };
    }

    if (toolName === 'delete_memory') {
        const memoryResult = await TOOL_EXECUTORS.delete_memory(args, { userId, sessionId });
        return {
            result: memoryResult,
            sources: [],
            searchCountInc: 0
        };
    }

    throw new Error(`不支持的工具: ${toolName}`);
}



async function callK2p5Stream({
    providerConfig,
    actualModel,
    messages,
    thinkingMode,
    thinkingBudget = 1024,
    internetMode,
    maxTokens,
    maxToolRounds = 2,
    searchBudget,
    taskKey,
    res,
    onContent,
    onReasoning,
    requestTimeoutMs = 45000
}) {
    let conversationMessages = [...messages];
    let aggregatedSources = [];
    let fullContent = '';
    let reasoningContent = '';
    let totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let searchCount = 0;

    for (let round = 0; round <= maxToolRounds; round += 1) {
        const requestBody = {
            model: actualModel,
            messages: conversationMessages,
            max_tokens: Math.max(256, parseInt(maxTokens, 10) || 2000),
            stream: true
        };
        if (isKimiK25ActualModel(actualModel)) {
            requestBody.enable_thinking = !!thinkingMode;
        } else {
            const budget = resolveThinkingBudgetForModel(actualModel, !!thinkingMode, thinkingBudget);
            if (budget !== null) {
                requestBody.thinking_budget = budget;
            }
        }

        if (internetMode) {
            requestBody.tools = TOOL_DEFINITIONS;
            requestBody.tool_choice = 'auto';
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs);
        let apiResponse;
        try {
            apiResponse = await fetch(providerConfig.baseURL, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${providerConfig.apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestBody),
                signal: controller.signal
            });
        } catch (error) {
            if (error.name === 'AbortError') {
                throw new Error(`Kimi K2 流式调用超时(${requestTimeoutMs}ms)`);
            }
            throw error;
        } finally {
            clearTimeout(timeoutId);
        }

        if (!apiResponse.ok || !apiResponse.body) {
            const errText = await apiResponse.text();
            throw new Error(`Kimi K2 流式调用失败 ${apiResponse.status}: ${errText.substring(0, 300)}`);
        }

        const reader = apiResponse.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        let finishReason = null;
        const toolCalls = [];
        let roundReasoningContent = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed === 'data: [DONE]') continue;
                if (!trimmed.startsWith('data: ')) continue;

                let parsed;
                try {
                    parsed = JSON.parse(trimmed.slice(6));
                } catch (e) {
                    continue;
                }

                if (parsed.usage) {
                    const chunkUsage = normalizeUsage(parsed.usage);
                    totalUsage.prompt_tokens += chunkUsage.prompt_tokens;
                    totalUsage.completion_tokens += chunkUsage.completion_tokens;
                    totalUsage.total_tokens += chunkUsage.total_tokens;
                }

                const choice = parsed.choices?.[0];
                if (!choice) continue;
                if (choice.finish_reason) finishReason = choice.finish_reason;
                const delta = choice.delta || {};

                const reasoningChunk = extractReasoningTextFromPayload(delta);
                if (reasoningChunk) {
                    reasoningContent += reasoningChunk;
                    roundReasoningContent += reasoningChunk;
                    if (onReasoning) onReasoning(reasoningChunk);
                }

                if (delta.content) {
                    fullContent += delta.content;
                    if (onContent) onContent(delta.content);
                }

                if (Array.isArray(delta.tool_calls)) {
                    for (const tc of delta.tool_calls) {
                        const idx = tc.index || 0;
                        if (!toolCalls[idx]) {
                            toolCalls[idx] = {
                                id: tc.id || `stream_tool_${Date.now()}_${idx}`,
                                type: 'function',
                                function: {
                                    name: tc.function?.name || '',
                                    arguments: ''
                                }
                            };
                        }
                        if (tc.id) toolCalls[idx].id = tc.id;
                        if (tc.function?.name) toolCalls[idx].function.name = tc.function.name;
                        if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
                    }
                }
            }
        }

        const normalizedCalls = normalizeToolCalls(toolCalls);
        if (!internetMode || finishReason !== 'tool_calls' || normalizedCalls.length === 0 || round >= maxToolRounds) {
            return {
                content: fullContent,
                reasoningContent,
                sources: dedupeSources(aggregatedSources),
                usage: totalUsage,
                searchCount
            };
        }

        const executedToolMessages = [];
        for (const toolCall of normalizedCalls) {
            const toolResult = await executeNormalizedToolCall({
                toolCall,
                taskKey,
                searchBudget,
                res,
                actualModel,
                thinkingMode
            });
            searchCount += Number(toolResult.searchCountInc || 0);
            const sourceAppendResult = appendAnnotatedSources(aggregatedSources, toolResult.sources);
            aggregatedSources = sourceAppendResult.merged;
            emitSourcesEvent(res, sourceAppendResult.newlyAdded);
            executedToolMessages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                content: JSON.stringify(buildToolResultForLLM({
                    toolName: toolCall.function.name,
                    result: toolResult.result,
                    sources: sourceAppendResult.newlyAdded,
                    args: toolCall._args || {}
                }))
            });
        }

        const assistantToolCallMessage = {
            role: 'assistant',
            content: null,
            tool_calls: normalizedCalls.map((call) => ({
                id: call.id,
                type: 'function',
                function: {
                    name: call.function.name,
                    arguments: call.function.arguments
                }
            }))
        };
        if (thinkingMode) {
            assistantToolCallMessage.reasoning_content = roundReasoningContent || 'Tool call continuation reasoning.';
        }

        conversationMessages = [
            ...conversationMessages,
            assistantToolCallMessage,
            ...executedToolMessages
        ];
    }

    return {
        content: fullContent,
        reasoningContent,
        sources: dedupeSources(aggregatedSources),
        usage: totalUsage,
        searchCount
    };
}

function researchModelLabel(modelId = '') {
    const labels = {
        'gemma': 'Gemma',
        'qwen3.6-35b-a3b': 'Qwen 3.6 35B',
        'kimi-k2.6': 'Kimi K2.6',
        'chatgpt-gpt-oss-120b': 'ChatGPT OSS 120B',
        'north-mini-code': 'Mimo Code',
        'nemotron-3-ultra': 'Nemotron 3 Ultra',
        'deepseek-flash': 'DeepSeek Flash',
        'deepseek-pro': 'DeepSeek Pro',
        'gemini-3-flash': 'Gemini 3 Flash',
        'openrouter-free': 'OpenRouter Free'
    };
    return labels[modelId] || modelId || 'Research Model';
}

function researchRoleFromModel(modelId = '') {
    if (modelId === 'gemma') return 'gemma';
    if (modelId === 'qwen3.6-35b-a3b') return 'qwen';
    if (modelId === 'kimi-k2.6') return 'kimi';
    if (modelId === 'chatgpt-gpt-oss-120b') return 'chatgpt';
    if (modelId === 'north-mini-code') return 'mimo';
    if (modelId === 'nemotron-3-ultra') return 'nemotron';
    if (modelId === 'deepseek-flash') return 'deepseek_flash';
    if (modelId === 'deepseek-pro') return 'deepseek';
    if (modelId === 'gemini-3-flash') return 'gemini';
    if (modelId === 'openrouter-free') return 'openrouter';
    return 'researcher';
}

const RESEARCH_MODEL_OPTIONS = [
    'gemma',
    'qwen3.6-35b-a3b',
    'kimi-k2.6',
    'chatgpt-gpt-oss-120b',
    'deepseek-pro',
    'deepseek-flash',
    'north-mini-code',
    'nemotron-3-ultra',
    'gemini-3-flash'
];
const DEFAULT_RESEARCH_AGENT_MODEL_IDS = ['gemma', 'qwen3.6-35b-a3b', 'chatgpt-gpt-oss-120b', 'deepseek-pro'];
const DEFAULT_RESEARCH_MASTER_MODEL_ID = 'deepseek-pro';

function normalizeResearchModelId(modelId = '') {
    const normalized = normalizeIncomingModelId(modelId);
    if (normalized === 'deepseek-v3' || normalized === 'deepseek-v3.2-speciale' || normalized === 'deepseek-v4-pro') return 'deepseek-pro';
    if (normalized === 'deepseek-v4-flash') return 'deepseek-flash';
    return normalized;
}

function normalizeResearchAgentModels(input) {
    const rawList = Array.isArray(input)
        ? input
        : (typeof input === 'string' ? input.split(',') : []);
    const selected = [];
    for (const item of rawList) {
        const modelId = normalizeResearchModelId(item);
        if (!RESEARCH_MODEL_OPTIONS.includes(modelId) || selected.includes(modelId)) continue;
        selected.push(modelId);
        if (selected.length >= 4) break;
    }
    return selected.length > 0 ? selected : [...DEFAULT_RESEARCH_AGENT_MODEL_IDS];
}

function normalizeResearchMasterModel(input) {
    const modelId = normalizeResearchModelId(input);
    return RESEARCH_MODEL_OPTIONS.includes(modelId) ? modelId : DEFAULT_RESEARCH_MASTER_MODEL_ID;
}

function getResearchFallbackCandidates(preferredModelId = '') {
    const preferred = normalizeResearchModelId(preferredModelId);
    return [
        preferred,
        ...UNIVERSAL_RUNTIME_FALLBACK_MODELS
    ].filter((modelId, index, list) => modelId && list.indexOf(modelId) === index);
}

async function isRoutableModelAvailable(modelId = '') {
    const normalized = normalizeResearchModelId(modelId);
    const routing = MODEL_ROUTING[normalized];
    const provider = routing ? API_PROVIDERS[routing.provider] : null;
    if (!routing || !provider?.apiKey) return false;
    if (PUBLIC_MODEL_IDS.includes(normalized) && await isPublicModelDisabled(normalized)) return false;
    return true;
}

async function resolveAvailableResearchModel(preferredModelId = '') {
    for (const candidate of getResearchFallbackCandidates(preferredModelId)) {
        if (await isRoutableModelAvailable(candidate)) return candidate;
    }
    return normalizeResearchModelId(preferredModelId);
}

function buildResearchSpeakers(modelIds = []) {
    const normalizedModels = normalizeResearchAgentModels(modelIds);
    return normalizedModels.map((modelId, index) => {
        const role = researchRoleFromModel(modelId);
        const label = researchModelLabel(modelId);
        const defaultTasks = {
            gemma: '从常识、表达和边界条件给出判断',
            kimi: '提出核心判断或质疑前序发言',
            chatgpt: '检查逻辑漏洞并修正结论',
            deepseek: '检查事实、前提和反例',
            deepseek_flash: '快速检查遗漏与可执行性',
            mimo: '从代码、工具和实现角度质疑方案',
            nemotron: '从大模型推理和长上下文角度补充反例',
            gemini: '从多模态和常识角度补充边界',
            openrouter: '作为底线模型给出保守检查'
        };
        return {
            agent_id: index + 1,
            role,
            modelId,
            label,
            task: defaultTasks[role] || `${label} 参与研究讨论并检查遗漏`
        };
    });
}

async function callResearchModelNonStreamWithFallback({ modelId, onFallbackAttempt, ...options }) {
    let lastError = null;
    for (const candidate of getResearchFallbackCandidates(modelId)) {
        if (!(await isRoutableModelAvailable(candidate))) {
            lastError = new Error(`${researchModelLabel(candidate)} 不可用`);
            continue;
        }
        if (candidate !== normalizeResearchModelId(modelId) && typeof onFallbackAttempt === 'function') {
            onFallbackAttempt(candidate, lastError);
        }
        try {
            return await callResearchModelNonStream({ modelId: candidate, ...options });
        } catch (error) {
            lastError = error;
            appendRaiRuntimeReport({
                level: '报错',
                tag: 'research_model_fallback_nonstream_failed',
                message: error.message,
                context: {
                    preferredModel: modelId,
                    candidate,
                    provider: MODEL_ROUTING[candidate]?.provider
                }
            });
        }
    }
    throw lastError || new Error(`${researchModelLabel(modelId)} 研究模型不可用`);
}

async function callResearchModelStreamWithFallback({ modelId, onFallbackAttempt, ...options }) {
    let lastError = null;
    for (const candidate of getResearchFallbackCandidates(modelId)) {
        if (!(await isRoutableModelAvailable(candidate))) {
            lastError = new Error(`${researchModelLabel(candidate)} 不可用`);
            continue;
        }
        if (candidate !== normalizeResearchModelId(modelId) && typeof onFallbackAttempt === 'function') {
            onFallbackAttempt(candidate, lastError);
        }
        try {
            return await callResearchModelStream({ modelId: candidate, ...options });
        } catch (error) {
            lastError = error;
            appendRaiRuntimeReport({
                level: '报错',
                tag: 'research_model_fallback_stream_failed',
                message: error.message,
                context: {
                    preferredModel: modelId,
                    candidate,
                    provider: MODEL_ROUTING[candidate]?.provider
                }
            });
        }
    }
    throw lastError || new Error(`${researchModelLabel(modelId)} 研究模型不可用`);
}

function truncateResearchText(text = '', maxLength = 8000) {
    const value = String(text || '').trim();
    if (value.length <= maxLength) return value;
    return `${value.slice(0, maxLength)}\n\n[内容已截断，保留前 ${maxLength} 字符]`;
}

function normalizeResearchMessageContent(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map((part) => {
            if (typeof part === 'string') return part;
            if (typeof part?.text === 'string') return part.text;
            if (typeof part?.content === 'string') return part.content;
            if (part?.type === 'text' && typeof part.text === 'string') return part.text;
            return '';
        }).join('');
    }
    if (content === null || content === undefined) return '';
    return String(content);
}

function buildGeminiResearchPayload({ messages = [], actualModel, maxTokens = 2000 }) {
    const contents = [];
    let systemInstructionText = '';

    for (const msg of messages) {
        const role = msg.role === 'assistant' ? 'model' : 'user';
        const text = normalizeResearchMessageContent(msg.content);
        if (!text) continue;

        if (msg.role === 'system') {
            systemInstructionText = systemInstructionText
                ? `${systemInstructionText}\n\n${text}`
                : text;
            continue;
        }

        contents.push({
            role,
            parts: [{ text }]
        });
    }

    const body = {
        contents,
        generationConfig: {
            temperature: 0.35,
            topP: 0.9,
            maxOutputTokens: Math.max(512, Math.min(parseInt(maxTokens, 10) || 2000, 8000))
        }
    };

    if (systemInstructionText) {
        body.systemInstruction = {
            parts: [{ text: systemInstructionText }]
        };
    }

    return {
        apiUrl: `${API_PROVIDERS.google_gemini.baseURL}/${actualModel}:streamGenerateContent?key=${API_PROVIDERS.google_gemini.apiKey}&alt=sse`,
        headers: { 'Content-Type': 'application/json' },
        body
    };
}

function buildResearchRequest({ modelId, messages, stream = false, thinkingMode = true, reasoningProfile = 'mixed', maxTokens = 2000 }) {
    const routing = MODEL_ROUTING[modelId];
    if (!routing) throw new Error(`深度研究模型路由缺失: ${modelId}`);

    const providerConfig = API_PROVIDERS[routing.provider];
    if (!providerConfig?.apiKey) {
        throw new Error(`深度研究模型缺少环境变量: ${providerConfig?.envKey || routing.provider || modelId}`);
    }

    let actualModel = routing.model;
    if (routing.provider === 'deepseek' && thinkingMode && routing.thinkingModel) {
        actualModel = routing.thinkingModel;
    }
    if ((modelId === 'kimi-k2.6' || modelId === 'kimi-k2') && thinkingMode && routing.thinkingModel) {
        actualModel = routing.thinkingModel;
    }

    if (routing.provider === 'google_gemini' || routing.isGemini || providerConfig.isGemini) {
        const geminiPayload = buildGeminiResearchPayload({ messages, actualModel, maxTokens });
        return {
            routing,
            providerConfig,
            actualModel,
            body: geminiPayload.body,
            apiUrl: geminiPayload.apiUrl,
            headers: geminiPayload.headers,
            isGeminiAPI: true
        };
    }

    const body = {
        model: actualModel,
        messages,
        max_tokens: Math.max(512, Math.min(parseInt(maxTokens, 10) || 2000, 8000)),
        stream: !!stream
    };

    if (routing.provider === 'siliconflow' && isKimiK25ActualModel(actualModel)) {
        body.enable_thinking = !!thinkingMode;
    } else {
        body.temperature = 0.35;
        body.top_p = 0.9;
    }

    if (routing.provider === 'deepseek') {
        applyDeepSeekV4ModeParams(body, !!thinkingMode, reasoningProfile);
    }
    if (routing.provider === 'newapi') {
        applyNewApiModelParams(body, actualModel, !!thinkingMode, reasoningProfile);
    }
    if (routing.provider === 'openrouter') {
        applyOpenRouterReasoningParams(body, actualModel, !!thinkingMode, reasoningProfile);
    }
    return {
        routing,
        providerConfig,
        actualModel,
        body,
        apiUrl: providerConfig.baseURL,
        headers: {
            Authorization: `Bearer ${providerConfig.apiKey}`,
            'Content-Type': 'application/json'
        },
        isGeminiAPI: false
    };
}

async function callResearchModelNonStream({
    modelId,
    messages,
    thinkingMode = true,
    reasoningProfile = 'mixed',
    maxTokens = 1800,
    timeoutMs = 55000
}) {
    const request = buildResearchRequest({
        modelId,
        messages,
        stream: false,
        thinkingMode,
        reasoningProfile,
        maxTokens
    });
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    try {
        response = await fetch(request.apiUrl || request.providerConfig.baseURL, {
            method: 'POST',
            headers: request.headers,
            body: JSON.stringify(request.body),
            signal: controller.signal
        });
    } catch (error) {
        if (error.name === 'AbortError') {
            throw new Error(`${researchModelLabel(modelId)} 深度研究调用超时(${timeoutMs}ms)`);
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`${researchModelLabel(modelId)} 深度研究调用失败 ${response.status}: ${errorText.substring(0, 260)}`);
    }

    const payload = await response.json();
    const choice = payload?.choices?.[0] || {};
    const message = choice.message || {};
    const rawContent = normalizeResearchMessageContent(message.content || choice.text || '');

    return {
        modelId,
        actualModel: request.actualModel,
        provider: request.routing.provider,
        content: rawContent.trim(),
        reasoningContent: extractReasoningTextFromPayload(message, choice, payload),
        usage: normalizeUsage(payload.usage)
    };
}

async function callResearchModelStream({
    modelId,
    messages,
    thinkingMode = true,
    reasoningProfile = 'mixed',
    maxTokens = 2400,
    timeoutMs = 120000,
    onContent,
    onReasoning
}) {
    const request = buildResearchRequest({
        modelId,
        messages,
        stream: true,
        thinkingMode,
        reasoningProfile,
        maxTokens
    });
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    try {
        response = await fetch(request.apiUrl || request.providerConfig.baseURL, {
            method: 'POST',
            headers: request.headers,
            body: JSON.stringify(request.body),
            signal: controller.signal
        });
    } catch (error) {
        if (error.name === 'AbortError') {
            throw new Error(`${researchModelLabel(modelId)} 主控生成超时(${timeoutMs}ms)`);
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }

    if (!response.ok || !response.body) {
        const errorText = await response.text();
        throw new Error(`${researchModelLabel(modelId)} 主控生成失败 ${response.status}: ${errorText.substring(0, 260)}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let content = '';
    let reasoningContent = '';
    let thinkCarry = '';
    let inThink = false;
    const THINK_START = '<think>';
    const THINK_END = '</think>';

    const splitThink = (chunk = '') => {
        let text = thinkCarry + String(chunk || '');
        thinkCarry = '';
        let visible = '';
        let reasoning = '';

        while (text.length > 0) {
            if (inThink) {
                const endIdx = text.indexOf(THINK_END);
                if (endIdx === -1) {
                    const safeLen = Math.max(0, text.length - (THINK_END.length - 1));
                    reasoning += text.slice(0, safeLen);
                    thinkCarry = text.slice(safeLen);
                    return { visible, reasoning };
                }
                reasoning += text.slice(0, endIdx);
                text = text.slice(endIdx + THINK_END.length);
                inThink = false;
                continue;
            }

            const startIdx = text.indexOf(THINK_START);
            if (startIdx === -1) {
                const partialIdx = text.lastIndexOf('<');
                if (partialIdx !== -1 && THINK_START.startsWith(text.slice(partialIdx))) {
                    visible += text.slice(0, partialIdx);
                    thinkCarry = text.slice(partialIdx);
                    return { visible, reasoning };
                }
                visible += text;
                text = '';
                continue;
            }

            visible += text.slice(0, startIdx);
            text = text.slice(startIdx + THINK_START.length);
            inThink = true;
        }

        return { visible, reasoning };
    };

    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            const flushed = buffer + decoder.decode();
            buffer = flushed ? `${flushed}\n` : '';
        } else {
            buffer += decoder.decode(value, { stream: true });
        }

        const lines = buffer.split(/\r?\n/);
        buffer = done ? '' : (lines.pop() || '');

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed === 'data: [DONE]') continue;
            if (!trimmed.startsWith('data: ')) continue;

            let parsed;
            try {
                parsed = JSON.parse(trimmed.slice(6));
            } catch (error) {
                continue;
            }

            if (parsed?.error) {
                const errMessage = typeof parsed.error === 'string'
                    ? parsed.error
                    : (parsed.error.message || JSON.stringify(parsed.error));
                throw new Error(`${researchModelLabel(modelId)} 主控流式事件错误: ${errMessage}`);
            }

            const eventReasoning = extractReasoningTextFromResponseEvent(parsed);
            if (eventReasoning) {
                reasoningContent += eventReasoning;
                if (onReasoning) onReasoning(eventReasoning);
                continue;
            }

            if (request.isGeminiAPI) {
                const candidate = parsed.candidates?.[0];
                const parts = candidate?.content?.parts || [];
                for (const part of parts) {
                    if (!part?.text) continue;
                    if (part.thought) {
                        const reasoningDelta = extractIncrementalChunk(reasoningContent, part.text);
                        if (reasoningDelta) {
                            reasoningContent += reasoningDelta;
                            if (onReasoning) onReasoning(reasoningDelta);
                        }
                    } else {
                        const visibleDelta = extractIncrementalChunk(content, part.text);
                        if (visibleDelta) {
                            content += visibleDelta;
                            if (onContent) onContent(visibleDelta);
                        }
                    }
                }
                continue;
            }

            const eventContent = extractOutputTextFromResponseEvent(parsed);
            const choice = parsed.choices?.[0] || {};
            const delta = choice.delta || {};
            const reasoning = extractReasoningTextFromPayload(delta);
            const contentChunk = eventContent || normalizeResearchMessageContent(delta.content || '');

            if (reasoning) {
                reasoningContent += reasoning;
                if (onReasoning) onReasoning(reasoning);
            }

            if (contentChunk) {
                const split = splitThink(contentChunk);
                if (split.reasoning) {
                    reasoningContent += split.reasoning;
                    if (onReasoning) onReasoning(split.reasoning);
                }
                if (split.visible) {
                    content += split.visible;
                    if (onContent) onContent(split.visible);
                }
            }
        }

        if (done) break;
    }

    return {
        modelId,
        actualModel: request.actualModel,
        provider: request.routing.provider,
        content,
        reasoningContent
    };
}

function extractResearchDebateStatus(content = '') {
    const text = String(content || '').trim();
    const statusMatch = text.match(/(?:结论状态|状态|status)\s*[：:]\s*([^\n\r]+)/i);
    const statusLine = statusMatch ? statusMatch[1].trim() : '';
    const noIssuePattern = /无重大问题|没有重大问题|无需继续质疑|达成一致|consensus|no\s+(?:blocking|major)\s+issues?/i;
    const hasIssuePattern = /仍有问题|有重大问题|需要修正|未达成一致|blocking\s+issues?|major\s+issues?|needs?\s+revision/i;

    if (statusLine) {
        if (noIssuePattern.test(statusLine)) {
            return { hasBlockingIssue: false, statusLine };
        }
        if (hasIssuePattern.test(statusLine)) {
            return { hasBlockingIssue: true, statusLine };
        }
    }

    if (noIssuePattern.test(text)) {
        return { hasBlockingIssue: false, statusLine: '无重大问题' };
    }

    return { hasBlockingIssue: true, statusLine: statusLine || '未明确' };
}



function compactResearchSpeech(content = '', maxChars = 220) {
    const rawText = String(content || '')
        .replace(/```[\s\S]*?```/g, '')
        .replace(/<\/?think>/gi, '')
        .trim();
    const usefulLines = rawText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !/^(?:结论状态|状态|status)\s*[：:]/i.test(line))
        .map((line) => line.replace(/^(?:发言|观点|结论|speech)\s*[：:]\s*/i, '').trim())
        .filter(Boolean);
    let text = usefulLines.join(' ').replace(/\s+/g, ' ').trim();
    if (!text) text = rawText.replace(/\s+/g, ' ').trim();

    const sentenceMatches = text.match(/[^。！？!?\.]+[。！？!?\.]?/g);
    if (sentenceMatches && sentenceMatches.length > 0) {
        text = sentenceMatches.slice(0, 2).join('').trim();
    }
    if (text.length > maxChars) {
        text = `${text.slice(0, maxChars).trim()}...`;
    }
    return text || '';
}

function extractResearchAskUserBlock(content = '') {
    const text = String(content || '');
    const match = text.match(/```rai_ask_user\s*\n[\s\S]*?\n```/i);
    return match ? match[0].trim() : '';
}

function researchNeedsClarification(content = '') {
    const text = String(content || '').replace(/```[\s\S]*?```/g, ' ').trim();
    if (!text) return false;
    return /(?:我需要更多信息才能判断|需要更多信息|信息不够|信息不足|缺少(?:关键)?信息|无法判断|无法评估|无法确定|无法给出判断|需要用户补充|need more information|insufficient information|not enough information|cannot determine|cannot judge)/i.test(text);
}

function buildResearchAskUserBlock({ speakerLabel = '研究模型' } = {}) {
    const payload = {
        question: `${speakerLabel} 认为还缺少关键条件。请补充背景、目标、限制或你希望优先判断的标准。`,
        options: [],
        placeholder: '补充信息后发送，RAI 会继续研究'
    };
    return `\`\`\`rai_ask_user\n${JSON.stringify(payload)}\n\`\`\``;
}

function buildResearchChatTranscript(speeches = [], maxChars = 4200, interjections = []) {
    const speechLines = speeches
        .map((speech) => {
            const status = speech.voteOk ? '无重大问题' : '仍有问题';
            return `第${speech.round}轮 ${speech.label}（${status}）：${speech.speech}`;
        });
    const interjectionLines = interjections
        .map((item) => `用户插话（${item.createdAt || '实时'}）：${item.content}`)
        .filter(Boolean);
    const text = [...speechLines, ...interjectionLines].join('\n');
    return truncateResearchText(text || '(暂无发言)', maxChars);
}

async function runResearchDebateMode({
    res,
    requestId,
    messages,
    userMessage,
    masterModelId,
    agentModelIds = DEFAULT_RESEARCH_AGENT_MODEL_IDS,
    researchMode = 'deep',
    debateThinkingMode = true,
    maxDebateRounds = 3,
    reasoningProfile = 'mixed',
    maxTokens = 2400,
    onContent,
    onReasoning,
    onAgentEvent = null
}) {
    const startedAt = Date.now();
    const masterId = await resolveAvailableResearchModel(normalizeResearchMasterModel(masterModelId));
    const debateMode = normalizeResearchMode(researchMode) === 'fast' ? 'fast' : 'deep';
    const useThinking = debateMode === 'deep' && debateThinkingMode !== false;
    const roundLimit = Math.max(1, Math.min(parseInt(maxDebateRounds, 10) || (debateMode === 'deep' ? 3 : 2), 50));
    const speechTokenLimit = debateMode === 'deep' ? 520 : 360;
    const speakers = buildResearchSpeakers(agentModelIds);
    for (const speaker of speakers) {
        speaker.modelId = await resolveAvailableResearchModel(speaker.modelId);
        speaker.role = researchRoleFromModel(speaker.modelId);
        speaker.label = researchModelLabel(speaker.modelId);
    }
    const totalSpeakers = speakers.length;
    const requiredOkVotes = Math.ceil(totalSpeakers * 0.75);

    const emitResearchEvent = (payload) => {
        emitAgentEvent(res, payload);
        if (typeof onAgentEvent === 'function') {
            try {
                onAgentEvent(payload);
            } catch (error) {
                console.warn(` 记录深度研究事件失败: ${error.message}`);
            }
        }
    };

    emitResearchEvent({
        type: 'agent_plan',
        mode: 'research_chat_debate',
        researchMode: debateMode,
        discussionRounds: roundLimit,
        stopRule: 'master_decides',
        totalSpeakers,
        masterModel: masterId,
        selectedAgents: speakers.map((speaker) => speaker.role),
        selectedModels: speakers.map((speaker) => speaker.modelId),
        tasks: [
            ...speakers.map((speaker) => ({
            agent_id: speaker.agent_id,
            stepId: `research-${speaker.role}`,
            role: speaker.role,
            task: speaker.task
            })),
            {
                agent_id: 999,
                stepId: 'research-master',
                role: 'master',
                task: `${researchModelLabel(masterId)} 判断是否继续讨论并输出最终正文`
            }
        ]
    });

    const appendInstruction = (baseMessages, instruction) => [
        ...baseMessages,
        {
            role: 'user',
            content: instruction
        }
    ];

    const speeches = [];
    const debateRounds = [];
    const userInterjections = [];
    let masterReadyToAnswer = false;
    let masterDecisionReason = '';

    const collectLiveUserInterjections = (round, beforeRole) => {
        const items = collectRequestInterjections(requestId);
        if (!items.length) return;
        for (const item of items) {
            const record = {
                ...item,
                round,
                beforeRole
            };
            userInterjections.push(record);
            emitResearchEvent({
                type: 'agent_interjection',
                role: 'user',
                round,
                beforeRole,
                detail: `用户插话: ${record.content.slice(0, 120)}`,
                content: record.content,
                createdAt: record.createdAt
            });
        }
    };

    const parseMasterDecision = (raw = '', isLastRound = false) => {
        const text = String(raw || '').trim();
        let payload = null;
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            try {
                payload = JSON.parse(jsonMatch[0]);
            } catch (error) {
                payload = null;
            }
        }
        const decisionText = String(payload?.decision || payload?.action || text).toLowerCase();
        const ready = /final|answer|generate|stop|无需|不需要|可以回答|生成正文|最终回答/.test(decisionText)
            && !/continue|继续|more|更多/.test(decisionText);
        const continueMore = /continue|继续|more|更多|再讨论|需要继续/.test(decisionText);
        return {
            ready: ready || (isLastRound && !continueMore),
            reason: String(payload?.reason || payload?.rationale || text || '').replace(/\s+/g, ' ').trim().slice(0, 240)
        };
    };

    for (let round = 1; round <= roundLimit; round += 1) {
        const roundResults = [];

        for (const [index, speaker] of speakers.entries()) {
            const stepId = `research-r${round}-${speaker.role}`;
            const taskId = (round - 1) * totalSpeakers + index + 1;
            const stepStartedAt = Date.now();
            collectLiveUserInterjections(round, speaker.role);

            emitResearchEvent({
                type: 'agent_status',
                role: speaker.role,
                scope: 'task',
                stepId,
                taskId,
                status: 'running',
                detail: `${speaker.label} 第${round}轮发言中`
            });

            try {
                let streamedSpeech = '';
                let streamedReasoning = '';
                const speechTask = `第${round}轮发言`;
                emitResearchEvent({
                    type: 'agent_draft_delta',
                    taskId,
                    stepId,
                    role: speaker.role,
                    task: speechTask,
                    speech: true,
                    round,
                    reset: true,
                    delta: ''
                });

                const transcript = buildResearchChatTranscript(speeches, debateMode === 'deep' ? 5200 : 3000, userInterjections);
                const result = await callResearchModelStreamWithFallback({
                    modelId: speaker.modelId,
                    messages: appendInstruction(messages, [
                        `[研究聊天第${round}轮：${speaker.label}]`,
                        `当前研究模式：${debateMode === 'deep' ? '深度研究' : '快速研究'}。`,
                        '你正在一个聊天软件气泡式讨论中发言。你只发言一次，必须短、准、在点上。',
                        '通常输出必须只有两行：',
                        '第一行必须从下面二选一：结论状态：无重大问题 / 结论状态：仍有问题',
                        '第二行必须写：发言：一句或两句，最多120个中文字符或80个英文单词。',
                        '开放性问题不要用“信息不足”逃避；除非确实缺少会改变答案的关键事实，否则必须基于已知上下文给出有用判断。',
                        '如果你确实认为缺少关键事实，不要说“我需要更多信息才能判断”，而是只输出一个 rai_ask_user 工具块：```rai_ask_user 后接 JSON（question、options、placeholder）再以 ``` 结束，不要输出其他文字。',
                        '质疑对象只能是此前模型发言，不要质疑用户的问题或用户的新插话。',
                        '如果前面模型有漏洞，要尖锐指出最关键漏洞和修正方向；如果认可，也必须说明还有哪些边界需要收紧，不要空泛附和。',
                        '不要输出给用户的最终正文，不要长篇分点；除 rai_ask_user 以外不要输出代码块。',
                        '',
                        '用户原问题：',
                        userMessage,
                        '',
                        '此前发言：',
                        transcript
                    ].join('\n')),
                    thinkingMode: useThinking,
                    reasoningProfile,
                    maxTokens: speechTokenLimit,
                    timeoutMs: debateMode === 'deep' ? 65000 : 45000,
                    onFallbackAttempt: (fallbackModel, previousError) => {
                        streamedSpeech = '';
                        streamedReasoning = '';
                        const fallbackLabel = researchModelLabel(fallbackModel);
                        emitResearchEvent({
                            type: 'agent_status',
                            role: speaker.role,
                            scope: 'task',
                            stepId,
                            taskId,
                            status: 'running',
                            detail: `${speaker.label} 调用失败，改用 ${fallbackLabel} 继续: ${previousError?.message || 'route unavailable'}`
                        });
                        speaker.modelId = fallbackModel;
                        speaker.role = researchRoleFromModel(fallbackModel);
                        speaker.label = fallbackLabel;
                        emitResearchEvent({
                            type: 'agent_draft_delta',
                            taskId,
                            stepId,
                            role: speaker.role,
                            task: speechTask,
                            speech: true,
                            round,
                            reset: true,
                            delta: ''
                        });
                    },
                    onContent: (chunk) => {
                        if (!chunk) return;
                        streamedSpeech += chunk;
                        emitResearchEvent({
                            type: 'agent_draft_delta',
                            taskId,
                            stepId,
                            role: speaker.role,
                            task: speechTask,
                            speech: true,
                            round,
                            delta: chunk
                        });
                    },
                    onReasoning: (chunk) => {
                        if (!chunk) return;
                        streamedReasoning += chunk;
                        emitResearchEvent({
                            type: 'agent_draft_delta',
                            taskId,
                            stepId,
                            role: speaker.role,
                            task: speechTask,
                            speech: true,
                            round,
                            reasoningDelta: chunk
                        });
                    }
                });

                const rawContent = truncateResearchText(result.content || streamedSpeech, 1200);
                const askUserBlock = extractResearchAskUserBlock(rawContent)
                    || (researchNeedsClarification(rawContent) ? buildResearchAskUserBlock({ speakerLabel: speaker.label }) : '');
                if (askUserBlock) {
                    emitResearchEvent({
                        type: 'agent_status',
                        role: speaker.role,
                        scope: 'task',
                        stepId,
                        taskId,
                        status: 'done',
                        detail: `${speaker.label} 请求用户补充关键信息`,
                        durationMs: Date.now() - stepStartedAt
                    });
                    if (typeof onContent === 'function') {
                        onContent(askUserBlock);
                    }
                    return {
                        finalModel: masterId,
                        actualModel: result.actualModel || masterId,
                        content: askUserBlock,
                        reasoningContent: truncateResearchText(result.reasoningContent || streamedReasoning, 3000),
                        sources: [],
                        usage: result.usage || {},
                        clarificationRequested: true,
                        researchMode: debateMode
                    };
                }
                const reasoningForBubble = truncateResearchText(result.reasoningContent || streamedReasoning, 3000);
                const debateStatus = extractResearchDebateStatus(rawContent);
                const speech = compactResearchSpeech(rawContent, debateMode === 'deep' ? 240 : 180);
                const voteOk = !debateStatus.hasBlockingIssue;
                const speechRecord = {
                    ok: true,
                    modelId: speaker.modelId,
                    role: speaker.role,
                    label: speaker.label,
                    stepId,
                    taskId,
                    round,
                    content: rawContent,
                    speech,
                    voteOk,
                    statusLine: debateStatus.statusLine,
                    reasoningContent: reasoningForBubble,
                    actualModel: result.actualModel,
                    provider: result.provider
                };
                speeches.push(speechRecord);
                roundResults.push(speechRecord);

                emitResearchEvent({
                    type: 'agent_draft',
                    taskId,
                    stepId,
                    role: speaker.role,
                    task: speechTask,
                    speech: true,
                    round,
                    voteOk,
                    statusLine: debateStatus.statusLine,
                    summary: speech,
                    content: speech,
                    rawContent,
                    reasoningContent: reasoningForBubble,
                    usage: result.usage || null,
                    debateRound: round,
                    hasBlockingIssue: debateStatus.hasBlockingIssue
                });
                emitResearchEvent({
                    type: 'agent_status',
                    role: speaker.role,
                    scope: 'task',
                    stepId,
                    taskId,
                    status: 'done',
                    detail: `${speaker.label} ${voteOk ? '完成本轮判断' : '提出需要修正的问题'}`,
                    durationMs: Date.now() - stepStartedAt
                });
            } catch (error) {
                emitResearchEvent({
                    type: 'agent_status',
                    role: speaker.role,
                    scope: 'task',
                    stepId,
                    taskId,
                    status: 'failed',
                    detail: `${speaker.label} 第${round}轮失败: ${error.message}`,
                    durationMs: Date.now() - stepStartedAt
                });
                const failedRecord = {
                    ok: false,
                    modelId: speaker.modelId,
                    role: speaker.role,
                    label: speaker.label,
                    stepId,
                    taskId,
                    content: '',
                    speech: `本轮调用失败：${error.message}`,
                    round,
                    debateRound: round,
                    hasBlockingIssue: true,
                    voteOk: false,
                    error: error.message
                };
                emitResearchEvent({
                    type: 'agent_draft',
                    taskId,
                    stepId,
                    role: speaker.role,
                    task: `第${round}轮发言`,
                    speech: true,
                    round,
                    voteOk: false,
                    statusLine: '结论状态：仍有问题',
                    summary: failedRecord.speech,
                    content: failedRecord.speech,
                    rawContent: failedRecord.speech,
                    debateRound: round,
                    hasBlockingIssue: true
                });
                roundResults.push(failedRecord);
            }
        }

        const successfulRound = roundResults.filter((item) => item.ok && item.speech);
        const okVotes = roundResults.filter((item) => item.ok && item.voteOk !== false && item.hasBlockingIssue !== true).length;
        collectLiveUserInterjections(round, 'master');
        const decisionStartedAt = Date.now();
        let decisionResult = { ready: round >= roundLimit, reason: round >= roundLimit ? '达到讨论轮次上限，进入最终综合。' : '' };
        try {
            emitResearchEvent({
                type: 'agent_status',
                role: 'master',
                scope: 'stage',
                stepId: `research-r${round}-master-check`,
                taskId: 900 + round,
                status: 'running',
                detail: `${researchModelLabel(masterId)} 判断是否还需要继续讨论`
            });
            const decisionPrompt = [
                `[研究主控判定第${round}轮]`,
                '你只判断是否还需要更多讨论，不输出给用户的正文。',
                `如果当前 ${speakers.map((speaker) => speaker.label).join('、')} 中至少 ${requiredOkVotes}/${totalSpeakers} 个模型认为没有重大问题，且讨论已经足够回答用户，就 decision=final。`,
                '如果存在会明显影响答案的关键漏洞、事实缺口或用户刚插话需要下一位模型吸收，就 decision=continue。',
                '输出严格 JSON：{"decision":"final|continue","reason":"一句话原因"}',
                '',
                '用户原问题：',
                userMessage,
                '',
                '实时讨论记录（含用户插话）：',
                buildResearchChatTranscript(speeches, debateMode === 'deep' ? 7600 : 4400, userInterjections)
            ].join('\n');
            const decisionRaw = await callResearchModelNonStreamWithFallback({
                modelId: masterId,
                messages: appendInstruction(messages, decisionPrompt),
                thinkingMode: false,
                reasoningProfile: 'low',
                maxTokens: 420,
                timeoutMs: debateMode === 'deep' ? 45000 : 30000,
                onFallbackAttempt: (fallbackModel, previousError) => {
                    emitResearchEvent({
                        type: 'agent_status',
                        role: 'master',
                        scope: 'stage',
                        stepId: `research-r${round}-master-check`,
                        taskId: 900 + round,
                        status: 'running',
                        detail: `主控 ${researchModelLabel(masterId)} 调用失败，改用 ${researchModelLabel(fallbackModel)} 判定: ${previousError?.message || 'route unavailable'}`
                    });
                }
            });
            decisionResult = parseMasterDecision(decisionRaw.content, round >= roundLimit);
            emitResearchEvent({
                type: 'agent_status',
                role: 'master',
                scope: 'stage',
                stepId: `research-r${round}-master-check`,
                taskId: 900 + round,
                status: 'done',
                detail: decisionResult.ready
                    ? `主控判断无需继续讨论: ${decisionResult.reason}`
                    : `主控判断继续讨论: ${decisionResult.reason}`,
                durationMs: Date.now() - decisionStartedAt
            });
        } catch (error) {
            decisionResult = {
                ready: round >= roundLimit,
                reason: round >= roundLimit
                    ? `主控判定失败且达到上限: ${error.message}`
                    : `主控判定失败，保守继续一轮: ${error.message}`
            };
            emitResearchEvent({
                type: 'agent_status',
                role: 'master',
                scope: 'stage',
                stepId: `research-r${round}-master-check`,
                taskId: 900 + round,
                status: decisionResult.ready ? 'done' : 'running',
                detail: decisionResult.reason,
                durationMs: Date.now() - decisionStartedAt
            });
        }

        if (okVotes < requiredOkVotes && round < roundLimit) {
            decisionResult = {
                ready: false,
                reason: `${okVotes}/${totalSpeakers} 个模型认为无重大问题，未达到 ${requiredOkVotes}/${totalSpeakers} 停止条件，继续讨论。`
            };
            emitResearchEvent({
                type: 'agent_status',
                role: 'master',
                scope: 'stage',
                stepId: `research-r${round}-vote-check`,
                taskId: 950 + round,
                status: 'running',
                detail: decisionResult.reason
            });
        } else if (okVotes < requiredOkVotes && round >= roundLimit) {
            decisionResult = {
                ready: true,
                reason: `${okVotes}/${totalSpeakers} 个模型认为无重大问题；已达到轮次上限，最终回答需保留关键边界。`
            };
        }

        masterReadyToAnswer = decisionResult.ready;
        masterDecisionReason = decisionResult.reason;
        debateRounds.push({
            round,
            results: roundResults,
            okVotes,
            requiredOkVotes,
            masterReadyToAnswer,
            masterDecisionReason
        });

        emitResearchEvent({
            type: 'agent_quality',
            round,
            pass: masterReadyToAnswer,
            metrics: {
                claimCoverage: okVotes,
                totalSpeakers,
                requiredOkVotes,
                stopRule: 'master_decides'
            },
            detail: masterReadyToAnswer
                ? `第${round}轮主控判断无需继续讨论，进入最终回答`
                : `第${round}轮主控判断继续讨论`
        });

        if (masterReadyToAnswer) {
            break;
        }
    }

    if (speeches.length === 0) {
        throw new Error('研究讨论没有任何可用发言，无法继续');
    }

    const critiqueResults = speeches;
    collectLiveUserInterjections(debateRounds.length || roundLimit, 'final');
    const critiqueBrief = buildResearchChatTranscript(speeches, debateMode === 'deep' ? 9000 : 5200, userInterjections);

    const masterStepStartedAt = Date.now();
    emitResearchEvent({
        type: 'agent_status',
        role: 'master',
        scope: 'stage',
        stepId: 'research-master',
        taskId: 999,
        status: 'running',
        detail: `${researchModelLabel(masterId)} 正在根据讨论输出最终回答`
    });

    const masterPrompt = [
        `[深度研究主控: ${researchModelLabel(masterId)}]`,
        `当前研究模式：${debateMode === 'deep' ? '深度研究' : '快速研究'}。`,
        `主控停止原因：${masterReadyToAnswer ? (masterDecisionReason || '主控判断无需继续讨论。') : '已达到讨论轮次上限，需要基于现有讨论保守综合。'}。`,
        `你将基于 ${speakers.map((speaker) => speaker.label).join('、')} 的聊天式讨论和用户实时插话处理用户问题。`,
        '要求：',
        '- 直接回答用户，不要复述“模型A/模型B说了什么”，也不要输出内部判定过程。',
        '- 必须吸收讨论中成立的质疑，修正过度确定、遗漏前提或逻辑跳步。',
        '- 最终主控不要再质疑用户，也不要用质疑口吻；请正经陈述修正后的答案。',
        '- 如果用户的问题信息不足，需要用独立的 rai_ask_user 代码块询问用户；questions 数组没有数量上限。',
        '- 如果使用 rai_ask_user，多问题必须等待用户把所有问题选完并点击发送后再继续。',
        '- 询问用户工具第一行必须精确使用 ```rai_ask_user，不要用 ```json、无语言代码块或普通文本 JSON 代替。',
        '- 使用用户当前语言；保持结构清楚、可执行、不过度冗长。',
        '',
        '用户原问题：',
        userMessage,
        '',
        '聊天式讨论记录：',
        critiqueBrief
    ].join('\n');

    const masterResult = await callResearchModelStreamWithFallback({
        modelId: masterId,
        messages: appendInstruction(messages, masterPrompt),
        thinkingMode: useThinking,
        reasoningProfile,
        maxTokens: debateMode === 'deep'
            ? Math.max(parseInt(maxTokens, 10) || 2400, 1800)
            : Math.max(Math.min(parseInt(maxTokens, 10) || 1800, 2600), 1200),
        timeoutMs: debateMode === 'deep' ? 140000 : 90000,
        onFallbackAttempt: (fallbackModel, previousError) => {
            emitResearchEvent({
                type: 'agent_status',
                role: 'master',
                scope: 'stage',
                stepId: 'research-master',
                taskId: 999,
                status: 'running',
                detail: `主控 ${researchModelLabel(masterId)} 生成失败，改用 ${researchModelLabel(fallbackModel)} 综合: ${previousError?.message || 'route unavailable'}`
            });
        },
        onContent: (chunk) => {
            if (onContent) onContent(chunk);
        },
        onReasoning
    });

    emitResearchEvent({
        type: 'agent_status',
        role: 'master',
        scope: 'stage',
        stepId: 'research-master',
        taskId: 999,
        status: 'done',
        detail: '深度研究主控综合完成',
        durationMs: Date.now() - masterStepStartedAt
    });
    emitResearchEvent({
        type: 'agent_metrics',
        mode: 'research_debate',
        researchMode: debateMode,
        durationMs: Date.now() - startedAt,
        successfulAgents: new Set(speeches.filter((item) => item.ok).map((item) => item.role)).size,
        critiqueCount: critiqueResults.filter((item) => item.ok && item.content).length,
        discussionRounds: debateRounds.length,
        stopRule: 'master_decides',
        masterReadyToAnswer,
        masterDecisionReason,
        interjectionCount: userInterjections.length,
        masterModel: masterResult.modelId || masterId
    });

    return {
        content: masterResult.content,
        reasoningContent: [
            ...speeches.map((item) => item.reasoningContent).filter(Boolean),
            masterResult.reasoningContent || ''
        ].join('\n'),
        finalModel: masterResult.modelId || masterId,
        actualModel: masterResult.actualModel,
        provider: masterResult.provider,
        trace: {
            initialResults: speeches.filter((item) => item.round === 1),
            critiqueResults,
            userInterjections,
            debateRounds,
            consensusReached: masterReadyToAnswer,
            stopRule: 'master_decides',
            masterDecisionReason,
            master: {
                modelId: masterResult.modelId || masterId,
                actualModel: masterResult.actualModel,
                provider: masterResult.provider
            }
        }
    };
}

async function runTrueParallelAgentMode({
    res,
    messages,
    userMessage,
    systemPrompt,
    userIdentityInstruction = '',
    domainInstruction = '',
    ruleInstruction = '',
    ruleMeta = null,
    thinkingMode,
    thinkingBudget = 1024,
    internetMode,
    qualityProfile,
    maxTokens,
    agentTraceLevel = 'full',
    onAgentEvent = null
}) {
    const routing = MODEL_ROUTING['kimi-k2.6'];
    if (!routing) throw new Error('K2.6 路由缺失');
    const providerConfig = API_PROVIDERS[routing.provider];
    if (!providerConfig) throw new Error('K2.6 提供商配置缺失');
    if (!providerConfig.apiKey) {
        throw new Error(`缺少环境变量: ${providerConfig.envKey || 'SILICONFLOW_API_KEY'}`);
    }

    const actualModel = routing.model;
    const searchBudget = createSearchBudget(8, 2);
    const historyContext = buildHistoryContext(messages, 6);
    const activeUserIdentityInstruction = String(userIdentityInstruction || '').trim();
    const activeDomainInstruction = String(domainInstruction || '').trim();
    const activeRuleInstruction = String(ruleInstruction || '').trim();
    const mergePromptSections = (...sections) => sections
        .map((section) => String(section || '').trim())
        .filter(Boolean)
        .join('\n\n');
    if (ruleMeta?.ruleId) {
        console.log(` Agent规则注入: ${ruleMeta.ruleId}`);
    }

    res.write(`data: ${JSON.stringify({
        type: 'model_info',
        model: 'kimi-k2.6',
        actualModel,
        reason: 'agent_mode_parallel',
        provider: routing.provider
    })}\n\n`);

    const emitContentChunk = (chunk) => {
        if (!chunk) return;
        res.write(`data: ${JSON.stringify({ type: 'content', content: chunk })}\n\n`);
    };
    const emitReasoningChunk = (chunk) => {
        if (!chunk) return;
        res.write(`data: ${JSON.stringify({ type: 'reasoning', content: chunk })}\n\n`);
    };

    const emitAgentEventWithHook = (payload) => {
        emitAgentEvent(res, payload);
        if (typeof onAgentEvent === 'function') {
            try {
                onAgentEvent(payload);
            } catch (hookError) {
                console.warn(' 记录Agent过程事件失败:', hookError.message);
            }
        }
    };

    const result = await runAgentPipeline({
        userMessage,
        historyMessages: messages,
        internetMode,
        thinkingMode,
        qualityProfile,
        maxSubAgents: 4,
        forceSubAgentCount: 4,
        maxRetries: AGENT_MAX_RETRIES,
        traceLevel: agentTraceLevel,
        emitEvent: emitAgentEventWithHook,
        onContent: emitContentChunk,
        onReasoning: emitReasoningChunk,
        callPlanner: async ({ plannerPrompt, userMessage: inputMessage }) => {
            const plannerSystemPrompt = mergePromptSections(
                plannerPrompt,
                activeUserIdentityInstruction,
                activeDomainInstruction,
                activeRuleInstruction
            );
            const plannerStepId = 'task-0';
            let plannerDraft = '';
            emitAgentEventWithHook({
                type: 'agent_status',
                role: 'planner',
                scope: 'task',
                stepId: plannerStepId,
                taskId: 0,
                status: 'start',
                detail: 'Planning task decomposition'
            });
            emitAgentEventWithHook({
                type: 'agent_draft_delta',
                taskId: 0,
                stepId: plannerStepId,
                role: 'planner',
                task: 'Planning task decomposition',
                reset: true,
                delta: ''
            });
            const plannerMessages = [
                { role: 'system', content: plannerSystemPrompt },
                {
                    role: 'user',
                    content: `用户问题:\n${inputMessage}\n\n最近对话:\n${historyContext || '(无)'}\n\n请严格输出JSON，不要附带任何解释。`
                }
            ];
            const plannerResult = await callK2p5Stream({
                providerConfig,
                actualModel,
                messages: plannerMessages,
                thinkingMode,
                thinkingBudget,
                internetMode: false,
                maxTokens: 1200,
                maxToolRounds: 0,
                searchBudget,
                taskKey: 'planner',
                res,
                onContent: (chunk) => {
                    if (!chunk) return;
                    plannerDraft += chunk;
                    emitAgentEventWithHook({
                        type: 'agent_draft_delta',
                        taskId: 0,
                        stepId: plannerStepId,
                        role: 'planner',
                        task: 'Planning task decomposition',
                        delta: chunk
                    });
                },
                onReasoning: () => { },
                requestTimeoutMs: 20000
            });
            if ((!plannerResult.content || !String(plannerResult.content).trim()) && plannerDraft.trim()) {
                plannerResult.content = plannerDraft;
            }
            const compactPlannerText = String(plannerResult.content || '').replace(/\s+/g, ' ').trim();
            emitAgentEventWithHook({
                type: 'agent_draft',
                stepId: plannerStepId,
                taskId: 0,
                role: 'planner',
                task: 'Planning task decomposition',
                summary: compactPlannerText.length > 80 ? `${compactPlannerText.slice(0, 80)}...` : compactPlannerText,
                content: plannerResult.content || '',
                usage: normalizeUsage(plannerResult.usage),
                searchCount: Number(plannerResult.searchCount || 0)
            });
            emitAgentEventWithHook({
                type: 'agent_status',
                role: 'planner',
                scope: 'task',
                stepId: plannerStepId,
                taskId: 0,
                status: 'done',
                detail: 'Planning task decomposition completed'
            });
            return plannerResult;
        },
        callSubAgent: async ({ task, subPrompt }) => {
            const taskId = Number(task.agent_id || 0) || 0;
            let streamedDraft = '';
            const subAgentSystemPrompt = mergePromptSections(
                subPrompt,
                activeUserIdentityInstruction,
                activeDomainInstruction,
                activeRuleInstruction
            );
            const subMessages = [
                { role: 'system', content: subAgentSystemPrompt },
                { role: 'user', content: '请完成任务并直接输出结果。' }
            ];
            emitAgentEventWithHook({
                type: 'agent_draft_delta',
                taskId,
                stepId: `task-${taskId}`,
                role: task.role || 'custom',
                task: task.task || '',
                reset: true,
                delta: ''
            });

            const subResult = await callK2p5Stream({
                providerConfig,
                actualModel,
                messages: subMessages,
                thinkingMode,
                thinkingBudget,
                internetMode,
                maxTokens: Math.min(Math.max(parseInt(maxTokens, 10) || 2000, 800), 6000),
                maxToolRounds: 2,
                searchBudget,
                taskKey: `task-${task.agent_id || 0}`,
                res,
                onContent: (chunk) => {
                    if (!chunk) return;
                    streamedDraft += chunk;
                    emitAgentEventWithHook({
                        type: 'agent_draft_delta',
                        taskId,
                        stepId: `task-${taskId}`,
                        role: task.role || 'custom',
                        task: task.task || '',
                        delta: chunk
                    });
                },
                onReasoning: () => { },
                requestTimeoutMs: internetMode ? 60000 : 40000
            });
            if ((!subResult.content || !String(subResult.content).trim()) && streamedDraft.trim()) {
                subResult.content = streamedDraft;
            }
            return subResult;
        },
        streamSynthesis: async ({ synthPrompt, userMessage: inputMessage, drafts }) => {
            const draftSummary = drafts.map((d) => `[task-${d.taskId}] ${d.summary}`).join('\n');
            const synthMessages = [];
            let masterDraftDeltaStarted = false;
            const mergedSystemPrompt = mergePromptSections(
                systemPrompt,
                activeUserIdentityInstruction,
                activeDomainInstruction,
                activeRuleInstruction
            );
            if (mergedSystemPrompt) {
                synthMessages.push({
                    role: 'system',
                    content: mergedSystemPrompt
                });
            }
            synthMessages.push({ role: 'system', content: synthPrompt });
            synthMessages.push({
                role: 'user',
                content: `请基于以下草稿给出最终回答:\n${draftSummary}\n\n原问题:\n${inputMessage}`
            });

            return await callK2p5Stream({
                providerConfig,
                actualModel,
                messages: synthMessages,
                thinkingMode,
                thinkingBudget,
                internetMode,
                maxTokens: Math.max(parseInt(maxTokens, 10) || 2000, 1200),
                maxToolRounds: 2,
                searchBudget,
                taskKey: 'synthesis',
                res,
                onContent: (chunk) => {
                    emitContentChunk(chunk);
                    if (!chunk) return;
                    if (!masterDraftDeltaStarted) {
                        masterDraftDeltaStarted = true;
                        emitAgentEventWithHook({
                            type: 'agent_draft_delta',
                            taskId: 999,
                            stepId: 'master-synthesis',
                            role: 'master',
                            task: '主控综合草稿',
                            reset: true,
                            delta: ''
                        });
                    }
                    emitAgentEventWithHook({
                        type: 'agent_draft_delta',
                        taskId: 999,
                        stepId: 'master-synthesis',
                        role: 'master',
                        task: '主控综合草稿',
                        delta: chunk
                    });
                },
                onReasoning: emitReasoningChunk,
                requestTimeoutMs: internetMode ? 75000 : 55000
            });
        },
        runVerifier: ({ qualityProfile, content, sources, fingerprint }) => applyQualityGate({
            qualityProfile,
            content,
            sources,
            fingerprint
        }),
        buildConservativeFallbackNote
    });

    return {
        ...result,
        finalModel: 'kimi-k2.6'
    };
}

// ==================== 多模态内容处理 (OpenAI兼容格式) ====================

function sanitizeClientMessageContent(content) {
    if (typeof content === 'string') {
        return content.replace(/\u0000/g, '').slice(0, CHAT_CLIENT_MAX_MESSAGE_CHARS);
    }
    if (Array.isArray(content)) {
        const textParts = [];
        for (const item of content.slice(0, 16)) {
            if (!item || typeof item !== 'object') continue;
            if (item.type === 'text' && typeof item.text === 'string') {
                textParts.push(item.text);
            }
        }
        return textParts.join('\n').replace(/\u0000/g, '').slice(0, CHAT_CLIENT_MAX_MESSAGE_CHARS);
    }
    return '';
}

function sanitizeClientAttachment(attachment = {}) {
    if (!attachment || typeof attachment !== 'object') return null;
    const type = String(attachment.type || '').trim().toLowerCase();
    if (!['image', 'audio', 'video', 'file', 'document'].includes(type)) return null;
    const data = typeof attachment.data === 'string'
        ? attachment.data.slice(0, 12 * 1024 * 1024)
        : '';
    return {
        type,
        fileName: String(attachment.fileName || attachment.originalName || '').slice(0, 255),
        originalName: String(attachment.originalName || '').slice(0, 255),
        fileId: path.basename(String(attachment.fileId || attachment.filename || '').slice(0, 255)),
        filename: path.basename(String(attachment.filename || '').slice(0, 255)),
        filePath: String(attachment.filePath || '').slice(0, 512),
        mimeType: String(attachment.mimeType || attachment.fileType || '').slice(0, 120),
        fileType: String(attachment.fileType || attachment.mimeType || '').slice(0, 120),
        size: Number.isFinite(Number(attachment.size)) ? Math.max(0, Number(attachment.size)) : 0,
        data
    };
}

function sanitizeClientAttachments(attachments) {
    if (!Array.isArray(attachments)) return [];
    return attachments
        .slice(0, CHAT_CLIENT_MAX_ATTACHMENTS)
        .map((attachment) => sanitizeClientAttachment(attachment))
        .filter(Boolean);
}

function sanitizeClientChatMessages(rawMessages = []) {
    const source = Array.isArray(rawMessages)
        ? rawMessages.slice(-CHAT_CLIENT_MAX_MESSAGES)
        : [];
    const messages = [];
    const rejectedRoles = [];
    let totalChars = 0;

    for (const item of source) {
        if (!item || typeof item !== 'object') continue;
        const role = String(item.role || '').trim().toLowerCase();
        if (!CHAT_CLIENT_ALLOWED_ROLES.has(role)) {
            rejectedRoles.push(role || '(empty)');
            continue;
        }

        let content = sanitizeClientMessageContent(item.content);
        const remaining = CHAT_CLIENT_MAX_TOTAL_CHARS - totalChars;
        if (remaining <= 0) break;
        if (content.length > remaining) {
            content = content.slice(0, remaining);
        }
        totalChars += content.length;

        const sanitized = { role, content };
        if (role === 'user') {
            const attachments = sanitizeClientAttachments(item.attachments);
            if (attachments.length > 0) sanitized.attachments = attachments;
        }
        messages.push(sanitized);
    }

    return { messages, rejectedRoles };
}

/**
 * 检测消息中是否包含多模态内容
 * @param {object} message - 消息对象
 * @returns {object} { hasMultimodal: boolean, types: string[] }
 */
function detectMultimodalContent(message) {
    const result = {
        hasMultimodal: false,
        types: [],  // 'image', 'audio', 'video'
        count: 0
    };

    if (!message) return result;

    //  调试：打印消息结构
    console.log(` 检测消息多模态内容:`, {
        role: message.role,
        contentType: typeof message.content,
        hasAttachments: !!message.attachments,
        attachmentsCount: message.attachments?.length || 0
    });

    // 如果content是数组，检查是否包含多模态内容
    if (Array.isArray(message.content)) {
        message.content.forEach(item => {
            if (item.type === 'image_url' || item.type === 'image') {
                result.hasMultimodal = true;
                result.types.push('image');
                result.count++;
            }
            if (item.type === 'input_audio' || item.type === 'audio') {
                result.hasMultimodal = true;
                result.types.push('audio');
                result.count++;
            }
            if (item.type === 'video') {
                result.hasMultimodal = true;
                result.types.push('video');
                result.count++;
            }
        });
    }

    //  增强防御性检查：处理 attachments 可能是字符串的情况
    let attachments = message.attachments;
    // 如果是字符串（从数据库加载的JSON），尝试解析
    if (typeof attachments === 'string') {
        try {
            attachments = JSON.parse(attachments);
        } catch (e) {
            attachments = [];
        }
    }

    // 检查message对象是否有attachments字段（增强防御性检查）
    if (Array.isArray(attachments) && attachments.length > 0) {
        console.log(` 发现附件:`, attachments.map(a => ({ type: a.type, fileName: a.fileName })));
        attachments.forEach(att => {
            if (att.type === 'image') {
                result.hasMultimodal = true;
                result.types.push('image');
                result.count++;
            }
            if (att.type === 'audio') {
                result.hasMultimodal = true;
                result.types.push('audio');
                result.count++;
            }
            if (att.type === 'video') {
                result.hasMultimodal = true;
                result.types.push('video');
                result.count++;
            }
        });
    }

    console.log(` 检测结果:`, result);
    return result;
}

/**
 * 检测消息数组中是否有多模态内容
 * @param {Array} messages - 消息数组
 * @returns {object} 多模态检测结果
 */


/**
 * 将带附件的消息转换为OpenAI兼容多模态格式
 * @param {object} message - 原始消息
 * @returns {object} 转换后的消息
 */
function getAttachmentUploadFilename(attachment = {}) {
    const direct = String(attachment.fileId || attachment.filename || '').trim();
    if (direct) return path.basename(direct);
    const filePath = String(attachment.filePath || '').trim();
    if (!filePath) return '';
    try {
        const parsed = new URL(filePath, 'https://rai.local');
        return path.basename(parsed.pathname || '');
    } catch (error) {
        return path.basename(filePath);
    }
}

function resolveImageMimeType(attachment = {}, filename = '') {
    const explicit = String(attachment.mimeType || attachment.fileType || '').trim().toLowerCase();
    if (explicit.startsWith('image/')) return explicit;
    const ext = path.extname(filename || attachment.fileName || attachment.originalName || '').toLowerCase();
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    if (ext === '.png') return 'image/png';
    if (ext === '.gif') return 'image/gif';
    if (ext === '.webp') return 'image/webp';
    if (ext === '.bmp') return 'image/bmp';
    if (ext === '.svg') return 'image/svg+xml';
    return 'image/png';
}

async function buildAttachmentImageDataUrl(attachment = {}, userId = null) {
    const existing = String(attachment.data || '').trim();
    if (existing.startsWith('data:image/')) return existing;

    const filename = getAttachmentUploadFilename(attachment);
    if (!filename) return '';
    if (filename !== path.basename(filename) || filename.includes('..')) return '';

    const uploadsRoot = path.resolve(__dirname, 'uploads');
    const filePath = path.resolve(uploadsRoot, filename);
    if (!(filePath === uploadsRoot || filePath.startsWith(`${uploadsRoot}${path.sep}`))) return '';

    if (userId) {
        const allowed = await userCanAccessUploadedFile(filename, userId);
        if (!allowed) return '';
    }

    const stats = await fs.promises.stat(filePath).catch(() => null);
    if (!stats || !stats.isFile() || stats.size <= 0 || stats.size > 12 * 1024 * 1024) return '';

    const mimeType = resolveImageMimeType(attachment, filename);
    if (!mimeType.startsWith('image/')) return '';
    const buffer = await fs.promises.readFile(filePath);
    return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

async function convertToOmniFormat(message, userId = null) {
    if (!message) return message;

    //  增强防御性检查：确保 attachments 是数组
    let attachments = message.attachments;
    // 如果是字符串（从数据库加载的JSON），尝试解析
    if (typeof attachments === 'string') {
        try {
            attachments = JSON.parse(attachments);
        } catch (e) {
            attachments = [];
        }
    }
    // 确保是数组
    if (!Array.isArray(attachments)) {
        attachments = [];
    }

    // 如果没有附件，检查content是否已经是数组格式
    if (attachments.length === 0) {
        // 如果content已经是数组格式（包含多模态内容），直接返回
        if (Array.isArray(message.content)) {
            return message;
        }
        // 纯文本消息
        return message;
    }

    // 将消息转换为多模态格式
    const contentArray = [];

    // 处理附件
    for (const attachment of attachments) {
        if (attachment.type === 'image') {
            const url = await buildAttachmentImageDataUrl(attachment, userId);
            if (url) {
                contentArray.push({
                    type: 'image_url',
                    image_url: { url }
                });
            }
        } else if (attachment.type === 'audio') {
            // 音频使用input_audio格式
            const data = attachment.data || '';
            if (data) {
                contentArray.push({
                    type: 'input_audio',
                    input_audio: { data }
                });
            }
        } else if (attachment.type === 'video') {
            // 视频使用video格式
            const data = attachment.data || '';
            if (data) {
                contentArray.push({
                    type: 'video',
                    video: [data]
                });
            }
        }
    }

    // 添加文本内容
    if (typeof message.content === 'string' && message.content.trim()) {
        contentArray.push({
            type: 'text',
            text: message.content
        });
    }

    return {
        role: message.role,
        content: contentArray
    };
}

/**
 * 转换消息数组为多模态格式（适配支持多模态的OpenAI兼容模型）
 * @param {Array} messages - 原始消息数组
 * @returns {Array} 转换后的消息数组
 */
async function convertMessagesToOmniFormat(messages, userId = null) {
    if (!messages || !Array.isArray(messages)) return messages;

    const converted = [];
    for (const msg of messages) {
        // 只转换可能包含附件的用户消息
        if (msg.role === 'user') {
            converted.push(await convertToOmniFormat(msg, userId));
        } else {
            converted.push(msg);
        }
    }
    return converted;
}

/**
 * 获取多模态消息的类型描述
 * @param {Array} types - 多模态类型数组
 * @returns {string} 类型描述
 */
function getMultimodalTypeDescription(types) {
    const map = {
        'image': '图片',
        'audio': '音频',
        'video': '视频'
    };
    return types.map(t => map[t] || t).join('、');
}

// ==================== 附件解析层：将附件内容转为 prompt 上下文 ====================
const ATTACHMENT_PARSE_MAX_FILE_CHARS = 60000;   // 单文件字符上限
const ATTACHMENT_PARSE_TOTAL_CHARS = 80000;       // 总字符上限

function classifyAttachmentType(fileName, mimeType) {
    const lowerName = String(fileName || '').toLowerCase();
    const lowerMime = String(mimeType || '').toLowerCase();
    // 图片
    if (lowerMime.startsWith('image/') || /\.(jpg|jpeg|png|gif|webp|svg|bmp|ico|tiff|heic|heif)$/i.test(lowerName)) {
        return 'image';
    }
    // 视频
    if (lowerMime.startsWith('video/') || /\.(mp4|webm|mkv|flv|wmv|avi|mov|m4v)$/i.test(lowerName)) {
        return 'video';
    }
    // 音频
    if (lowerMime.startsWith('audio/') || /\.(mp3|wav|m4a|ogg|flac|aac|wma|opus)$/i.test(lowerName)) {
        return 'audio';
    }
    // 代码
    if (/\.(js|ts|jsx|tsx|py|java|c|cpp|h|hpp|css|scss|less|html|htm|vue|svelte|swift|kt|go|rs|rb|php|sh|bash|zsh|sql|pl)$/i.test(lowerName)) {
        return 'code';
    }
    // 文本
    if (/\.(txt|md|json|xml|csv|log|yaml|yml|ini|conf)$/i.test(lowerName) || lowerMime === 'text/plain' || lowerMime === 'application/json') {
        return 'text';
    }
    // 文档
    if (/\.(pdf|docx|xlsx|xls|pptx|ppt|csv)$/i.test(lowerName) || lowerMime === 'application/pdf' || lowerMime.includes('officedocument') || lowerMime.includes('spreadsheet')) {
        return 'document';
    }
    return 'other';
}

async function readTextFileContent(filePath) {
    try {
        const content = await fs.promises.readFile(filePath, 'utf-8');
        return content;
    } catch (err) {
        console.warn(` 读取文本附件失败: ${filePath}`, err.message);
        return null;
    }
}

async function tryExtractDocxText(filePath) {
    try {
        // 尝试使用 mammoth 提取 DOCX 文本
        const mammoth = require('mammoth');
        const result = await mammoth.extractRawText({ path: filePath });
        return (result && result.value) ? result.value.trim() : null;
    } catch (err) {
        // mammoth 不可用时回退到原始 ZIP XML 提取
        try {
            const { execSync } = require('child_process');
            const tmpDir = require('os').tmpdir();
            const dest = `${tmpDir}/_rai_docx_extract_${Date.now()}`;
            execSync(`unzip -o "${filePath}" -d "${dest}" 2>/dev/null && cat "${dest}/word/document.xml" 2>/dev/null || true`, { timeout: 5000 });
            const xml = await fs.promises.readFile(`${dest}/word/document.xml`, 'utf-8').catch(() => '');
            // 简单去除 XML 标签
            const text = xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            try { execSync(`rm -rf "${dest}"`, { timeout: 2000 }); } catch (cleanupErr) {}
            return text || null;
        } catch (e2) {
            console.warn(` DOCX 文本提取失败: ${filePath}`, e2.message);
            return null;
        }
    }
}

async function tryExtractXlsxCsvText(filePath) {
    try {
        // XLSX 是 ZIP，尝试提取 shared strings 和 sheet 数据
        const { execSync } = require('child_process');
        const tmpDir = require('os').tmpdir();
        const dest = `${tmpDir}/_rai_xlsx_extract_${Date.now()}`;
        execSync(`unzip -o "${filePath}" -d "${dest}" 2>/dev/null || true`, { timeout: 5000 });
        // 读取 shared strings
        let sharedStrings = '';
        try { sharedStrings = await fs.promises.readFile(`${dest}/xl/sharedStrings.xml`, 'utf-8'); } catch (e) {}
        // 读取第一个 sheet
        let sheet1 = '';
        try { sheet1 = await fs.promises.readFile(`${dest}/xl/worksheets/sheet1.xml`, 'utf-8'); } catch (e) {}
        try { execSync(`rm -rf "${dest}"`, { timeout: 2000 }); } catch (cleanupErr) {}
        // 简单提取文本内容
        const parts = [];
        if (sharedStrings) {
            const texts = sharedStrings.match(/<t[^>]*>([^<]*)<\/t>/g);
            if (texts) {
                const cleaned = texts.map(t => t.replace(/<[^>]+>/g, '').trim()).filter(Boolean);
                parts.push(`[单元格数据]: ${cleaned.join(' | ')}`);
            }
        }
        if (sheet1 && !parts.length) {
            const text = sheet1.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            if (text) parts.push(`[工作表内容]: ${text}`);
        }
        return parts.length > 0 ? parts.join('\n') : null;
    } catch (err) {
        console.warn(` XLSX 文本提取失败: ${filePath}`, err.message);
        return null;
    }
}

async function tryExtractPptxText(filePath) {
    try {
        const { execSync } = require('child_process');
        const tmpDir = require('os').tmpdir();
        const dest = `${tmpDir}/_rai_pptx_extract_${Date.now()}`;
        execSync(`unzip -o "${filePath}" -d "${dest}" 2>/dev/null || true`, { timeout: 5000 });
        // 读取所有 slide XML 文件
        const slidesDir = `${dest}/ppt/slides`;
        let slides = [];
        try {
            const files = await fs.promises.readdir(slidesDir);
            for (const f of files.sort()) {
                if (f.endsWith('.xml')) {
                    const xml = await fs.promises.readFile(`${slidesDir}/${f}`, 'utf-8');
                    const text = xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                    if (text) slides.push(text);
                }
            }
        } catch (e) {}
        try { execSync(`rm -rf "${dest}"`, { timeout: 2000 }); } catch (cleanupErr) {}
        return slides.length > 0 ? slides.map((s, i) => `[幻灯片${i + 1}]: ${s}`).join('\n') : null;
    } catch (err) {
        console.warn(` PPTX 文本提取失败: ${filePath}`, err.message);
        return null;
    }
}

async function tryExtractPdfText(filePath) {
    try {
        const pdfParse = require('pdf-parse');
        const buffer = await fs.promises.readFile(filePath);
        const data = await pdfParse(buffer);
        return (data && data.text) ? data.text.trim() : null;
    } catch (err) {
        console.warn(` PDF 文本提取失败 (pdf-parse 不可用): ${filePath}`, err.message);
        return null;
    }
}

/**
 * 构建附件上下文文本，追加到用户的 prompt 中
 * @param {Array} attachments - 附件元数据数组 [{ type, fileName, mimeType, size, fileId, filePath }]
 * @param {string} userId - 用户 ID（用于归属校验）
 * @returns {Promise<string>} 附件上下文文本（可能为空字符串）
 */
async function buildAttachmentPromptContext(attachments, userId) {
    if (!Array.isArray(attachments) || attachments.length === 0) return '';

    let totalChars = 0;
    const parts = [];

    for (const att of attachments) {
        if (totalChars >= ATTACHMENT_PARSE_TOTAL_CHARS) {
            parts.push('[附件解析已达总量上限，剩余附件内容略]');
            break;
        }

        const fileName = att.fileName || att.originalName || 'unknown';
        const mimeType = att.mimeType || '';
        const attType = classifyAttachmentType(fileName, mimeType);
        const fileId = att.fileId || null;

        // 构建文件路径
        let filePath = null;
        if (fileId) {
            const candidate = path.resolve(__dirname, 'uploads', fileId);
            if (candidate.startsWith(path.resolve(__dirname, 'uploads'))) {
                // 校验归属
                try {
                    const allowed = await userCanAccessUploadedFile(fileId, userId);
                    if (allowed) {
                        filePath = candidate;
                    }
                } catch (e) { /* 归属校验失败，跳过 */ }
            }
        }

        // 根据类型提取文本
        if (attType === 'text' || attType === 'code') {
            if (filePath) {
                const content = await readTextFileContent(filePath);
                if (content !== null) {
                    const truncated = content.length > ATTACHMENT_PARSE_MAX_FILE_CHARS
                        ? content.slice(0, ATTACHMENT_PARSE_MAX_FILE_CHARS) + '\n[...内容过长，已截断]'
                        : content;
                    const label = attType === 'code' ? `[附件代码文件: ${fileName}]` : `[附件文本文件: ${fileName}]`;
                    parts.push(`${label}\n\`\`\`\n${truncated}\n\`\`\``);
                    totalChars += truncated.length;
                } else {
                    parts.push(`[附件: ${fileName} (无法读取)]`);
                }
            } else {
                parts.push(`[附件: ${fileName} (文件不可用)]`);
            }
        } else if (attType === 'document') {
            if (filePath) {
                const ext = path.extname(fileName).toLowerCase();
                let extracted = null;
                if (ext === '.pdf' || mimeType === 'application/pdf') {
                    extracted = await tryExtractPdfText(filePath);
                } else if (ext === '.docx') {
                    extracted = await tryExtractDocxText(filePath);
                } else if (ext === '.xlsx' || ext === '.xls' || ext === '.csv') {
                    if (ext === '.csv') {
                        extracted = await readTextFileContent(filePath);
                    } else {
                        extracted = await tryExtractXlsxCsvText(filePath);
                    }
                } else if (ext === '.pptx' || ext === '.ppt') {
                    extracted = await tryExtractPptxText(filePath);
                }
                if (extracted) {
                    const truncated = extracted.length > ATTACHMENT_PARSE_MAX_FILE_CHARS
                        ? extracted.slice(0, ATTACHMENT_PARSE_MAX_FILE_CHARS) + '\n[...内容过长，已截断]'
                        : extracted;
                    parts.push(`[附件文档: ${fileName}]\n${truncated}`);
                    totalChars += truncated.length;
                } else {
                    parts.push(`[附件文档: ${fileName} (无法解析内容，请根据文件名和元数据回答)]`);
                }
            } else {
                parts.push(`[附件文档: ${fileName} (文件不可用)]`);
            }
        } else if (attType === 'image' || attType === 'video' || attType === 'audio') {
            // 媒体类型：如果模型支持多模态，会通过 convertToOmniFormat 传递原始数据
            // 这里仅添加一个提示，方便不支持多模态的模型知道有媒体附件
            const typeDesc = attType === 'image' ? '图片' : (attType === 'video' ? '视频' : '音频');
            parts.push(`[用户上传了一个${typeDesc}文件: ${fileName}，请根据文件名和上下文回答]`);
        } else {
            parts.push(`[附件: ${fileName} (${attType || '未知类型'})]`);
        }
    }

    if (parts.length === 0) return '';

    return '\n\n--- 附件内容 ---\n' + parts.join('\n\n') + '\n--- 附件内容结束 ---';
}

// ==================== API配置系统 ====================
const API_PROVIDERS = {
    aliyun: {
        apiKey: ENV_API_KEYS.ALIYUN_API_KEY,
        envKey: 'ALIYUN_API_KEY',
        baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
        models: [] // 官方文本模型已下线
    },
    // 阿里云多模态模型预留 (支持图片、音频、视频输入和语音输出)
    aliyun_omni: {
        apiKey: ENV_API_KEYS.ALIYUN_API_KEY,
        envKey: 'ALIYUN_API_KEY',
        baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
        models: [], // 官方多模态模型已下线
        multimodal: true,  // 标记支持多模态
        audioOutput: true  // 支持语音输出
    },
    deepseek: {
        apiKey: ENV_API_KEYS.DEEPSEEK_API_KEY,
        envKey: 'DEEPSEEK_API_KEY',
        baseURL: 'https://api.deepseek.com/v1/chat/completions',
        models: ['deepseek-v4-flash', 'deepseek-v4-pro']
    },

    // 硅基流动 SiliconFlow - Qwen 多模态与 Kimi K2.6
    siliconflow: {
        apiKey: ENV_API_KEYS.SILICONFLOW_API_KEY,
        envKey: 'SILICONFLOW_API_KEY',
        baseURL: 'https://api.siliconflow.cn/v1/chat/completions',
        imageGenerationURL: SILICONFLOW_IMAGE_GENERATION_URL,
        models: ['Qwen/Qwen3.6-35B-A3B', 'Pro/moonshotai/Kimi-K2.6']
    },
    // Google Generative Language API - Gemini/Gemma models
    google_gemini: {
        apiKey: ENV_API_KEYS.GOOGLE_GEMINI_API_KEY,
        envKey: 'GOOGLE_GEMINI_API_KEY',
        baseURL: GOOGLE_GEMINI_BASE_URL,  // 基础URL，实际使用时会拼接模型名
        models: ['gemini-3-flash-preview', 'gemma-4-31b-it'],
        isGemini: true,  // 标记这是Gemini API，需要特殊处理
        multimodal: true  // 支持图片/视频等多模态输入
    },
    // OpenRouter OpenAI-compatible API
    openrouter: {
        apiKey: ENV_API_KEYS.OPENROUTER_API_KEY,
        envKey: 'OPENROUTER_API_KEY',
        baseURL: OPENROUTER_BASE_URL,
        models: [
            'anthropic/claude-sonnet-4.6',
            'anthropic/claude-3-haiku',
            'openai/gpt-oss-120b:free',
            'google/gemma-4-31b-it:free',
            'cohere/north-mini-code:free',
            'nvidia/nemotron-3-ultra-550b-a55b:free',
            'openrouter/free'
        ]
    },
    // NewAPI OpenAI-compatible gateway
    newapi: {
        apiKey: ENV_API_KEYS.NEWAPI_API_KEY,
        envKey: 'NEWAPI_API_KEY',
        baseURL: NEWAPI_BASE_URL,
        models: []
    }
};

function logApiKeyReadiness() {
    const missing = [];
    const seen = new Set();
    Object.values(API_PROVIDERS).forEach((provider) => {
        if (!provider?.envKey || seen.has(provider.envKey)) return;
        seen.add(provider.envKey);
        if (!provider.apiKey) missing.push(provider.envKey);
    });
    if (!TAVILY_API_KEY) missing.push('TAVILY_API_KEY');

    if (missing.length > 0) {
        console.warn(` 缺少API环境变量: ${missing.join(', ')}`);
    } else {
        console.log(' API环境变量已就绪');
    }
}

logApiKeyReadiness();

const LEGACY_MODEL_ALIASES = {
    'qwen3-vl': 'qwen3.6-35b-a3b',
    'qwen3.6-35b-a3b': 'qwen3.6-35b-a3b',
    'Qwen/Qwen3.6-35B-A3B': 'qwen3.6-35b-a3b',
    'qwen/qwen3.6-35b-a3b': 'qwen3.6-35b-a3b',
    'qwen3-8b': 'auto',
    'qwen-flash': 'auto',
    'qwen-plus': 'auto',
    'qwen-max': 'auto',
    'qwen2.5-7b': 'auto',
    'grok-4.2': 'auto',
    'deepseek-chat': 'deepseek-pro',
    'deepseek-reasoner': 'deepseek-pro',
    'gpt-5.5': 'auto',
    'deepseek-v3': 'deepseek-pro',
    'deepseek-v3.2-speciale': 'deepseek-pro',
    'deepseek-v4-pro': 'deepseek-pro',
    'deepseek-v4-flash': 'deepseek-flash',
    'kimi-k2.5': 'kimi-k2.6',
    'Pro/moonshotai/Kimi-K2.5': 'kimi-k2.6',
    'Pro/moonshotai/Kimi-K2.6': 'kimi-k2.6',
    'claude-haiku': 'anthropic/claude-3-haiku',
    'anthropic/claude-3-haiku:beta': 'anthropic/claude-3-haiku',
    'cohere/north-mini-code:free': 'north-mini-code',
    'nvidia/nemotron-3-ultra-550b-a55b:free': 'nemotron-3-ultra',
    'google/gemma-4-31b-it:free': 'gemma',
    'openrouter/free': 'openrouter-free'
};

const SUPPORTED_INCOMING_MODEL_IDS = new Set([
    ...PUBLIC_MODEL_IDS,
    'auto',
    'kimi-k2',
    'claude-haiku',
    'gemini-3-flash',
    'openrouter-free'
]);

function normalizeIncomingModelId(modelId = 'auto') {
    const normalized = String(modelId || 'auto').trim();
    const aliased = LEGACY_MODEL_ALIASES[normalized] || normalized;
    if (String(aliased).startsWith('x-ai/grok-4.20')) return 'auto';
    return SUPPORTED_INCOMING_MODEL_IDS.has(aliased) ? aliased : 'auto';
}

// 模型路由映射 (支持auto模式)
const MODEL_ROUTING = {
    // 具体模型配置
    'deepseek-flash': {
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        supportsThinking: false,
        supportsWebSearch: false,
        multimodal: false
    },
    'deepseek-pro': {
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
        thinkingModel: 'deepseek-v4-pro',
        supportsThinking: true,
        supportsWebSearch: false,
        multimodal: false
    },
    // Qwen 3.6 35B - 便宜多模态模型
    'qwen3.6-35b-a3b': {
        provider: 'siliconflow',
        model: 'Qwen/Qwen3.6-35B-A3B',
        supportsWebSearch: false,
        supportsThinking: false,
        multimodal: true
    },
    // Kimi K2.6 - 月之暗面高性能模型
    'kimi-k2.6': {
        provider: 'siliconflow',
        model: 'Pro/moonshotai/Kimi-K2.6',
        thinkingModel: 'Pro/moonshotai/Kimi-K2.6',
        supportsWebSearch: true,
        multimodal: true
    },
    // 兼容旧配置: kimi-k2 自动路由到 K2.6
    'kimi-k2': {
        provider: 'siliconflow',
        model: 'Pro/moonshotai/Kimi-K2.6',
        thinkingModel: 'Pro/moonshotai/Kimi-K2.6',
        supportsWebSearch: true,  // 支持Tavily联网搜索
        multimodal: true
    },
    // OpenRouter 模型
    'chatgpt-gpt-oss-120b': {
        provider: 'openrouter',
        model: 'openai/gpt-oss-120b:free',
        supportsThinking: true,
        supportsWebSearch: false,
        multimodal: false
    },
    'north-mini-code': {
        provider: 'openrouter',
        model: 'cohere/north-mini-code:free',
        supportsThinking: false,
        supportsWebSearch: false,
        multimodal: false
    },
    'nemotron-3-ultra': {
        provider: 'openrouter',
        model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
        supportsThinking: true,
        supportsWebSearch: false,
        multimodal: false
    },
    'claude-haiku': {
        provider: 'openrouter',
        model: 'anthropic/claude-3-haiku',
        fallbackModels: ['anthropic/claude-3-haiku'],
        supportsThinking: false,
        supportsWebSearch: false,
        multimodal: true
    },
    'anthropic/claude-sonnet-4.6': {
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-4.6',
        fallbackModels: ['anthropic/claude-sonnet-4.6'],
        supportsThinking: false,
        supportsWebSearch: false,
        multimodal: true
    },
    'anthropic/claude-3-haiku': {
        provider: 'openrouter',
        model: 'anthropic/claude-3-haiku',
        fallbackModels: ['anthropic/claude-3-haiku'],
        supportsThinking: false,
        supportsWebSearch: false,
        multimodal: true
    },
    'gemma': {
        provider: 'openrouter',
        model: 'google/gemma-4-31b-it:free',
        supportsThinking: true,
        supportsWebSearch: false,
        multimodal: false,
        contextWindow: 256000,
        maxOutputTokens: 8000
    },
    'openrouter-free': {
        provider: 'openrouter',
        model: 'openrouter/free',
        fallbackModels: ['openrouter/free'],
        supportsThinking: true,
        supportsWebSearch: false,
        multimodal: false
    },
    // Google Gemini 3 Flash - 最智能的速度优化模型（多模态）
    'gemini-3-flash': {
        provider: 'google_gemini',
        model: 'gemini-3-flash-preview',
        isGemini: true,  // 标记需要特殊处理
        multimodal: true,  // 支持图片/视频等多模态输入
        supportsWebSearch: true  // 支持Tavily联网搜索
    },
    // 关键修复：将 'auto' 标记为特殊的虚拟路由，表示需要动态选择
    'auto': {
        provider: 'auto',  // 虚拟提供商，表示需要动态决策
        model: 'auto',     // 虚拟模型，表示需要通过智能路由选择
        isAutoMode: true   // 标记这是auto模式
    }
};

const UNIVERSAL_RUNTIME_FALLBACK_MODELS = [
    'chatgpt-gpt-oss-120b',
    'gemma',
    'north-mini-code',
    'nemotron-3-ultra',
    'gemini-3-flash',
    'qwen3.6-35b-a3b',
    'kimi-k2.6',
    'openrouter-free'
];

function getRuntimeFallbackModelIds(currentModel = '', options = {}) {
    const current = normalizeIncomingModelId(currentModel);
    const requiresMultimodal = options.requiresMultimodal === true;
    return UNIVERSAL_RUNTIME_FALLBACK_MODELS.filter((modelId) => {
        if (modelId === current) return false;
        if (!requiresMultimodal) return true;
        return MODEL_ROUTING[modelId]?.multimodal === true;
    });
}

function findAvailableRuntimeFallbackModelId(currentModel = '', options = {}) {
    return getRuntimeFallbackModelIds(currentModel, options).find((modelId) => {
        const route = MODEL_ROUTING[modelId];
        const provider = route ? API_PROVIDERS[route.provider] : null;
        return !!(route && provider?.apiKey);
    }) || null;
}

function resolveFreeFallbackModelId(currentModel = '', options = {}) {
    return findAvailableRuntimeFallbackModelId(currentModel, options) || (options.requiresMultimodal ? 'qwen3.6-35b-a3b' : 'openrouter-free');
}


// 创建目录
const dirs = ['uploads', 'uploads/generated-images', 'avatars', 'database'];
dirs.forEach(dir => {
    const dirPath = path.join(__dirname, dir);
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
        console.log(` 已创建目录: ${dir}`);
    }
});

// 数据库初始化
const dbPath = path.resolve(process.env.RAI_DB_PATH || path.join(__dirname, 'ai_data.db'));
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error(' 数据库连接失败:', err);
        process.exit(1);
    } else {
        console.log(' 数据库已连接:', dbPath);

        // ==================== SQLite 性能优化 ====================
        db.run("PRAGMA foreign_keys=ON;", (err) => {
            if (err) console.warn(' 外键约束启用失败:', err.message);
            else console.log(' SQLite 外键约束已启用');
        });
        db.run("PRAGMA journal_mode=WAL;", (err) => {
            if (err) console.warn(' WAL模式设置失败:', err.message);
            else console.log(' SQLite WAL模式已启用');
        });
        db.run("PRAGMA cache_size=10000;");  // 约40MB缓存
        db.run("PRAGMA busy_timeout=5000;"); // 5秒锁等待超时
        db.run("PRAGMA synchronous=NORMAL;"); // 平衡性能与安全
        db.run("PRAGMA temp_store=MEMORY;");  // 临时表存内存
    }
});

// 创建所有表
db.serialize(() => {
    // 用户表
    db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    email_verified INTEGER DEFAULT 1,
    email_verified_at DATETIME,
    pending_email TEXT,
    pending_email_current_code_hash TEXT,
    pending_email_current_verified_at INTEGER,
    pending_email_code_hash TEXT,
    pending_email_expires_at INTEGER,
    username TEXT,
    avatar_url TEXT,
    pending_referrer_id INTEGER,
    external_provider TEXT,
    external_uid TEXT,
    two_factor_enabled INTEGER DEFAULT 0,
    two_factor_secret TEXT,
    two_factor_confirmed_at DATETIME,
    gpt55_usage_date DATE,
    gpt55_usage_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME
  )`);

    // 会话表
    db.run(`CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    title TEXT DEFAULT '新对话',
    model TEXT DEFAULT 'auto',
    session_kind TEXT DEFAULT 'chat',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_archived INTEGER DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

    // 消息表
    db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    attachments TEXT,
    reasoning_content TEXT,
    model TEXT,
    enable_search INTEGER DEFAULT 0,
    thinking_mode INTEGER DEFAULT 0,
    internet_mode INTEGER DEFAULT 0,
    process_trace TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  )`);

    // 用户配置表
    db.run(`CREATE TABLE IF NOT EXISTS user_configs (
    user_id INTEGER PRIMARY KEY,
    theme TEXT DEFAULT 'light',
    default_model TEXT DEFAULT 'auto',
    temperature REAL DEFAULT 0.7,
    top_p REAL DEFAULT 0.9,
    max_tokens INTEGER DEFAULT 2000,
    frequency_penalty REAL DEFAULT 0,
    presence_penalty REAL DEFAULT 0,
    system_prompt TEXT,
    thinking_mode INTEGER DEFAULT 0,
    internet_mode INTEGER DEFAULT 1,
    long_memory_enabled INTEGER DEFAULT 0,
    long_memory_opted_in_at DATETIME,
    short_memory_titles TEXT,
    short_memory_updated_at DATETIME,
    font_preference TEXT DEFAULT 'rai',
    tab_title_mode TEXT DEFAULT 'default',
    tab_title_custom_text TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

    db.run(`CREATE TABLE IF NOT EXISTS user_memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    memory_key TEXT NOT NULL,
    category TEXT DEFAULT 'other',
    content TEXT NOT NULL,
    confidence REAL DEFAULT 0.8,
    source_session_id TEXT,
    source_message_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    deleted_at DATETIME,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, memory_key)
  )`);

    // 活跃请求表
    db.run(`CREATE TABLE IF NOT EXISTS active_requests (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_cancelled INTEGER DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

    db.run(`CREATE TABLE IF NOT EXISTS stream_drafts (
    request_id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    user_content TEXT,
    assistant_content TEXT DEFAULT '',
    reasoning_content TEXT DEFAULT '',
    model TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  )`);

    // 设备指纹表
    db.run(`CREATE TABLE IF NOT EXISTS device_fingerprints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    fingerprint TEXT NOT NULL,
    device_name TEXT,
    last_used DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

    // ChatFlow 表
    db.run(`CREATE TABLE IF NOT EXISTS flows (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    title TEXT DEFAULT '新 ChatFlow',
    session_id TEXT,
    chat_history TEXT DEFAULT '[]',
    canvas_state TEXT DEFAULT '{"nodes":[],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

    db.run(`CREATE TABLE IF NOT EXISTS auth_ztx6d_rt (
    rt TEXT PRIMARY KEY,
    return_path TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER,
    bind_user_id INTEGER
  )`);

    db.run(`CREATE TABLE IF NOT EXISTS auth_ztx6d_codes (
    code TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    email TEXT NOT NULL,
    provider TEXT DEFAULT 'ztx6d',
    return_path TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

    db.run(`CREATE TABLE IF NOT EXISTS message_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    rating TEXT NOT NULL CHECK (rating IN ('up', 'down')),
    comment TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, message_id),
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

    db.run(`CREATE TABLE IF NOT EXISTS model_visibility (
    model_id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

    if (DEFAULT_DISABLED_MODEL_IDS.length) {
        DEFAULT_DISABLED_MODEL_IDS.forEach((modelId) => {
            db.run(
                `INSERT INTO model_visibility (model_id, enabled, updated_at)
                 VALUES (?, 0, CURRENT_TIMESTAMP)
                 ON CONFLICT(model_id) DO NOTHING`,
                [modelId],
                (err) => {
                    if (err) {
                        console.warn(` 默认禁用模型种子写入失败(${modelId}):`, err.message);
                    }
                }
            );
        });
        console.log(` 默认禁用模型种子已加载: ${DEFAULT_DISABLED_MODEL_IDS.join(', ')}`);
    }

  db.run(`CREATE TABLE IF NOT EXISTS announcements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    title_en TEXT,
    body_en TEXT,
    delivery_mode TEXT NOT NULL DEFAULT 'silent'
        CHECK (delivery_mode IN ('popup', 'toast', 'silent')),
    start_at TEXT,
    end_at TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

    db.run(`ALTER TABLE announcements ADD COLUMN title_en TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column')) {
            console.warn(' 添加公告英文标题列失败:', err.message);
        }
    });

    db.run(`ALTER TABLE announcements ADD COLUMN body_en TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column')) {
            console.warn(' 添加公告英文正文列失败:', err.message);
        }
    });

    db.run(`CREATE TABLE IF NOT EXISTS user_task_rewards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    task_key TEXT NOT NULL,
    points INTEGER NOT NULL DEFAULT 0,
    metadata TEXT,
    completed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, task_key),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

    db.run(`CREATE TABLE IF NOT EXISTS file_uploads (
    filename TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    original_name TEXT,
    mime_type TEXT,
    size INTEGER,
    upload_kind TEXT NOT NULL DEFAULT 'attachment',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

    db.run(`CREATE TABLE IF NOT EXISTS auth_email_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    user_id INTEGER,
    purpose TEXT NOT NULL CHECK (purpose IN ('register', 'login', 'password_reset')),
    code_hash TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    metadata TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER,
    request_ip TEXT,
    user_agent TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

    db.run(`CREATE TABLE IF NOT EXISTS user_two_factor_setup_challenges (
    setup_id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    secret TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

    db.run(`CREATE TABLE IF NOT EXISTS admin_runtime_settings (
    setting_key TEXT PRIMARY KEY,
    setting_value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`, (err) => {
        if (err) {
            console.warn(' admin_runtime_settings 表创建失败:', err.message);
            return;
        }
        for (const [key, value] of Object.entries(ADMIN_RUNTIME_LIMIT_DEFAULTS)) {
            db.run(
                `INSERT INTO admin_runtime_settings (setting_key, setting_value, updated_at)
                 VALUES (?, ?, CURRENT_TIMESTAMP)
                 ON CONFLICT(setting_key) DO NOTHING`,
                [key, String(value)]
            );
        }
    });

    db.run(`CREATE TABLE IF NOT EXISTS user_chat_usage (
    user_id INTEGER NOT NULL,
    window_type TEXT NOT NULL,
    window_start INTEGER NOT NULL,
    usage_count INTEGER NOT NULL DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, window_type, window_start),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

    console.log(' 所有数据表就绪');

    const defaultNoticeSeed = getDefaultDomainNoticeSeed();
    if (defaultNoticeSeed) {
        db.all(
            `SELECT id, title, body
             FROM announcements
             WHERE title = ?
             ORDER BY id ASC`,
            [defaultNoticeSeed.titleZh],
            (seedErr, rows = []) => {
                if (seedErr) {
                    console.warn(' 公告种子检查失败:', seedErr.message);
                    return;
                }
                const row = rows.find((candidate) => isManagedDefaultDomainNotice(candidate));
                if (!row) {
                    db.run(
                    `INSERT INTO announcements (title, body, title_en, body_en, delivery_mode, start_at, end_at, enabled)
                     VALUES (?, ?, ?, ?, 'toast', NULL, NULL, 1)`,
                    [
                        defaultNoticeSeed.titleZh,
                        defaultNoticeSeed.bodyZh,
                        defaultNoticeSeed.titleEn,
                        defaultNoticeSeed.bodyEn
                    ],
                    (insErr) => {
                        if (insErr) console.warn(' 公告种子写入失败:', insErr.message);
                        else console.log(' 默认域名公告种子就绪');
                    }
                    );
                } else {
                    db.run(
                    `UPDATE announcements
                     SET title = ?,
                         body = ?,
                         title_en = ?,
                         body_en = ?,
                         updated_at = CURRENT_TIMESTAMP
                     WHERE id = ?`,
                    [
                        defaultNoticeSeed.titleZh,
                        defaultNoticeSeed.bodyZh,
                        defaultNoticeSeed.titleEn,
                        defaultNoticeSeed.bodyEn,
                        row.id
                    ],
                    (updErr) => {
                        if (updErr) console.warn(' 默认域名公告种子更新失败:', updErr.message);
                        else console.log(' 默认域名公告种子已同步');
                    }
                    );
                }
            }
        );
    }

    //  数据库迁移：添加缺失的列（如果表已存在且列不存在）
    db.serialize(() => {
        // 添加thinking_mode列（如果不存在）
        db.run(`ALTER TABLE user_configs ADD COLUMN thinking_mode INTEGER DEFAULT 0`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加thinking_mode列失败(可能已存在):`, err.message);
            } else if (!err) {
                console.log(' 已添加thinking_mode列到user_configs表');
            }
        });

        // 添加internet_mode列（如果不存在）
        db.run(`ALTER TABLE user_configs ADD COLUMN internet_mode INTEGER DEFAULT 1`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加internet_mode列失败(可能已存在):`, err.message);
            } else if (!err) {
                console.log(' 已添加internet_mode列到user_configs表');
            }
        });

        db.run(`ALTER TABLE user_configs ADD COLUMN long_memory_enabled INTEGER DEFAULT 0`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加long_memory_enabled列失败(可能已存在):`, err.message);
            } else if (!err) {
                console.log(' 已添加long_memory_enabled列到user_configs表');
            }
        });

        db.run(`ALTER TABLE user_configs ADD COLUMN long_memory_opted_in_at DATETIME`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加long_memory_opted_in_at列失败(可能已存在):`, err.message);
            } else if (!err) {
                console.log(' 已添加long_memory_opted_in_at列到user_configs表');
            }
        });

        db.run(`ALTER TABLE user_configs ADD COLUMN short_memory_titles TEXT`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加short_memory_titles列失败(可能已存在):`, err.message);
            } else if (!err) {
                console.log(' 已添加short_memory_titles列到user_configs表');
            }
        });

        db.run(`ALTER TABLE user_configs ADD COLUMN short_memory_updated_at DATETIME`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加short_memory_updated_at列失败(可能已存在):`, err.message);
            } else if (!err) {
                console.log(' 已添加short_memory_updated_at列到user_configs表');
            }
        });

        db.run(`ALTER TABLE user_configs ADD COLUMN font_preference TEXT DEFAULT 'rai'`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加font_preference列失败(可能已存在):`, err.message);
            } else if (!err) {
                console.log(' 已添加font_preference列到user_configs表');
            }
        });

        db.run(`ALTER TABLE user_configs ADD COLUMN tab_title_mode TEXT DEFAULT 'default'`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加tab_title_mode列失败(可能已存在):`, err.message);
            } else if (!err) {
                console.log(' 已添加tab_title_mode列到user_configs表');
            }
        });

        db.run(`ALTER TABLE user_configs ADD COLUMN tab_title_custom_text TEXT`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加tab_title_custom_text列失败(可能已存在):`, err.message);
            } else if (!err) {
                console.log(' 已添加tab_title_custom_text列到user_configs表');
            }
        });


        // 添加model列到messages表（如果不存在）
        db.run(`ALTER TABLE messages ADD COLUMN model TEXT`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加model列失败(可能已存在):`, err.message);
            } else if (!err) {
                console.log(' 已添加model列到messages表');
            }
        });

        // 添加enable_search列到messages表（如果不存在）
        db.run(`ALTER TABLE messages ADD COLUMN enable_search INTEGER DEFAULT 0`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加enable_search列失败(可能已存在):`, err.message);
            } else if (!err) {
                console.log(' 已添加enable_search列到messages表');
            }
        });

        // 添加thinking_mode列到messages表（如果不存在）
        db.run(`ALTER TABLE messages ADD COLUMN thinking_mode INTEGER DEFAULT 0`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加thinking_mode列失败(可能已存在):`, err.message);
            } else if (!err) {
                console.log(' 已添加thinking_mode列到messages表');
            }
        });

        // 添加internet_mode列到messages表（如果不存在）
        db.run(`ALTER TABLE messages ADD COLUMN internet_mode INTEGER DEFAULT 0`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加internet_mode列失败(可能已存在):`, err.message);
            } else if (!err) {
                console.log(' 已添加internet_mode列到messages表');
            }
        });

        // 添加sources列到messages表（如果不存在）- 存储联网搜索来源信息（JSON格式）
        db.run(`ALTER TABLE messages ADD COLUMN sources TEXT`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加sources列失败(可能已存在):`, err.message);
            } else if (!err) {
                console.log(' 已添加sources列到messages表');
            }
        });

        // 添加process_trace列到messages表（如果不存在）- 存储Agent过程轨迹（JSON格式）
        db.run(`ALTER TABLE messages ADD COLUMN process_trace TEXT`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加process_trace列失败(可能已存在):`, err.message);
            } else if (!err) {
                console.log(' 已添加process_trace列到messages表');
            }
        });

        db.run(`ALTER TABLE sessions ADD COLUMN session_kind TEXT DEFAULT 'chat'`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加session_kind列失败(可能已存在):`, err.message);
            } else if (!err) {
                console.log(' 已添加session_kind列到sessions表');
            }
        });

        db.run(`ALTER TABLE flows ADD COLUMN session_id TEXT`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加session_id列失败(可能已存在):`, err.message);
            } else if (!err) {
                console.log(' 已添加session_id列到flows表');
            }
        });

        db.run(`ALTER TABLE users ADD COLUMN external_provider TEXT`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加external_provider列失败(可能已存在):`, err.message);
            } else if (!err) {
                console.log(' 已添加external_provider列到users表');
            }
        });

        db.run(`ALTER TABLE users ADD COLUMN external_uid TEXT`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加external_uid列失败(可能已存在):`, err.message);
            } else if (!err) {
                console.log(' 已添加external_uid列到users表');
            }
        });

        db.run(`ALTER TABLE users ADD COLUMN email_verified INTEGER DEFAULT 1`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加email_verified列失败(可能已存在):`, err.message);
            } else if (!err) {
                console.log(' 已添加email_verified列到users表');
            }
            db.run(
                `UPDATE users
                 SET email_verified = 1
                 WHERE COALESCE(email_verified, 1) = 1`
            );
        });

        db.run(`ALTER TABLE users ADD COLUMN email_verified_at DATETIME`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加email_verified_at列失败(可能已存在):`, err.message);
            } else if (!err) {
                console.log(' 已添加email_verified_at列到users表');
            }
            db.run(
                `UPDATE users
                 SET email_verified_at = COALESCE(email_verified_at, created_at, CURRENT_TIMESTAMP)
                 WHERE COALESCE(email_verified, 1) = 1`
            );
        });

        db.run(`ALTER TABLE users ADD COLUMN pending_email TEXT`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加pending_email列失败(可能已存在):`, err.message);
            } else if (!err) {
                console.log(' 已添加pending_email列到users表');
            }
        });

        db.run(`ALTER TABLE users ADD COLUMN pending_email_current_code_hash TEXT`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加pending_email_current_code_hash列失败(可能已存在):`, err.message);
            } else if (!err) {
                console.log(' 已添加pending_email_current_code_hash列到users表');
            }
        });

        db.run(`ALTER TABLE users ADD COLUMN pending_email_current_verified_at INTEGER`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加pending_email_current_verified_at列失败(可能已存在):`, err.message);
            } else if (!err) {
                console.log(' 已添加pending_email_current_verified_at列到users表');
            }
        });

        db.run(`ALTER TABLE users ADD COLUMN pending_email_code_hash TEXT`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加pending_email_code_hash列失败(可能已存在):`, err.message);
            } else if (!err) {
                console.log(' 已添加pending_email_code_hash列到users表');
            }
        });

        db.run(`ALTER TABLE users ADD COLUMN pending_email_expires_at INTEGER`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加pending_email_expires_at列失败(可能已存在):`, err.message);
            } else if (!err) {
                console.log(' 已添加pending_email_expires_at列到users表');
            }
        });

        db.run(`ALTER TABLE users ADD COLUMN pending_referrer_id INTEGER`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加pending_referrer_id列失败(可能已存在):`, err.message);
            } else if (!err) {
                console.log(' 已添加pending_referrer_id列到users表');
            }
        });

        db.run(`ALTER TABLE users ADD COLUMN two_factor_enabled INTEGER DEFAULT 0`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加two_factor_enabled列失败(可能已存在):`, err.message);
            } else if (!err) {
                console.log(' 已添加two_factor_enabled列到users表');
            }
        });

        db.run(`ALTER TABLE users ADD COLUMN two_factor_secret TEXT`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加two_factor_secret列失败(可能已存在):`, err.message);
            } else if (!err) {
                console.log(' 已添加two_factor_secret列到users表');
            }
        });

        db.run(`ALTER TABLE users ADD COLUMN two_factor_confirmed_at DATETIME`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加two_factor_confirmed_at列失败(可能已存在):`, err.message);
            } else if (!err) {
                console.log(' 已添加two_factor_confirmed_at列到users表');
            }
        });

        db.run(`ALTER TABLE auth_ztx6d_rt ADD COLUMN bind_user_id INTEGER`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加ZTX6D bind_user_id列失败(可能已存在):`, err.message);
            } else if (!err) {
                console.log(' 已添加bind_user_id列到auth_ztx6d_rt表');
            }
        });

        // 创建索引以加速查询
        // 注意：索引方向要与查询一致（ASC）
        db.run(`CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at ASC, id ASC)`, (err) => {
            if (err) {
                console.warn(` 创建messages索引失败:`, err.message);
            } else {
                console.log(' messages表索引就绪');
            }
        });

        db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_user_updated ON sessions(user_id, is_archived, updated_at DESC)`, (err) => {
            if (err) {
                console.warn(` 创建sessions索引失败:`, err.message);
            } else {
                console.log(' sessions表索引就绪');
            }
        });

        db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_user_kind_updated ON sessions(user_id, session_kind, is_archived, updated_at DESC)`, (err) => {
            if (err) {
                console.warn(` 创建sessions(session_kind)索引失败:`, err.message);
            } else {
                console.log(' sessions(session_kind)索引就绪');
            }
        });

        db.run(`CREATE INDEX IF NOT EXISTS idx_user_memories_user_active ON user_memories(user_id, deleted_at, updated_at DESC)`, (err) => {
            if (err) {
                console.warn(` 创建user_memories(active)索引失败:`, err.message);
            } else {
                console.log(' user_memories(active)索引就绪');
            }
        });

        db.run(`CREATE INDEX IF NOT EXISTS idx_user_memories_user_key ON user_memories(user_id, memory_key)`, (err) => {
            if (err) {
                console.warn(` 创建user_memories(key)索引失败:`, err.message);
            } else {
                console.log(' user_memories(key)索引就绪');
            }
        });

        db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_external_identity ON users(external_provider, external_uid) WHERE external_provider IS NOT NULL AND external_uid IS NOT NULL`, (err) => {
            if (err) {
                console.warn(` 创建users外部身份索引失败:`, err.message);
            } else {
                console.log(' users外部身份索引就绪');
            }
        });

        db.run(`CREATE INDEX IF NOT EXISTS idx_auth_ztx6d_rt_expires ON auth_ztx6d_rt(expires_at)`, (err) => {
            if (err) {
                console.warn(` 创建ZTX6D rt索引失败:`, err.message);
            } else {
                console.log(' ZTX6D rt索引就绪');
            }
        });

        db.run(`CREATE INDEX IF NOT EXISTS idx_auth_ztx6d_codes_expires ON auth_ztx6d_codes(expires_at)`, (err) => {
            if (err) {
                console.warn(` 创建ZTX6D auth_code索引失败:`, err.message);
            } else {
                console.log(' ZTX6D auth_code索引就绪');
            }
        });

        db.run(`CREATE INDEX IF NOT EXISTS idx_auth_email_codes_lookup ON auth_email_codes(email, purpose, consumed_at, expires_at DESC, id DESC)`, (err) => {
            if (err) {
                console.warn(` 创建邮箱验证码查找索引失败:`, err.message);
            } else {
                console.log(' 邮箱验证码查找索引就绪');
            }
        });

        db.run(`CREATE INDEX IF NOT EXISTS idx_auth_email_codes_expires ON auth_email_codes(expires_at, consumed_at)`, (err) => {
            if (err) {
                console.warn(` 创建邮箱验证码过期索引失败:`, err.message);
            } else {
                console.log(' 邮箱验证码过期索引就绪');
            }
        });

        db.run(`CREATE INDEX IF NOT EXISTS idx_users_pending_email ON users(pending_email, pending_email_expires_at)`, (err) => {
            if (err) {
                console.warn(` 创建待确认邮箱索引失败:`, err.message);
            } else {
                console.log(' 待确认邮箱索引就绪');
            }
        });

        db.run(`CREATE INDEX IF NOT EXISTS idx_user_2fa_setup_challenges_user ON user_two_factor_setup_challenges(user_id, expires_at, consumed_at)`, (err) => {
            if (err) {
                console.warn(` 创建二步验证设置挑战索引失败:`, err.message);
            } else {
                console.log(' 二步验证设置挑战索引就绪');
            }
        });

        db.run(`CREATE INDEX IF NOT EXISTS idx_message_feedback_created ON message_feedback(created_at DESC)`, (err) => {
            if (err) {
                console.warn(` 创建message_feedback时间索引失败:`, err.message);
            } else {
                console.log(' message_feedback时间索引就绪');
            }
        });

        db.run(`CREATE INDEX IF NOT EXISTS idx_message_feedback_rating_created ON message_feedback(rating, created_at DESC)`, (err) => {
            if (err) {
                console.warn(` 创建message_feedback评分索引失败:`, err.message);
            } else {
                console.log(' message_feedback评分索引就绪');
            }
        });

        db.run(`CREATE INDEX IF NOT EXISTS idx_user_task_rewards_user ON user_task_rewards(user_id, completed_at DESC)`, (err) => {
            if (err) {
                console.warn(` 创建user_task_rewards用户索引失败:`, err.message);
            } else {
                console.log(' user_task_rewards用户索引就绪');
            }
        });

        db.run(`CREATE INDEX IF NOT EXISTS idx_file_uploads_user ON file_uploads(user_id, created_at DESC)`, (err) => {
            if (err) {
                console.warn(` 创建file_uploads用户索引失败:`, err.message);
            } else {
                console.log(' file_uploads用户索引就绪');
            }
        });

        db.run(`CREATE INDEX IF NOT EXISTS idx_user_chat_usage_user_window ON user_chat_usage(user_id, window_type, window_start)`, (err) => {
            if (err) {
                console.warn(` 创建user_chat_usage索引失败:`, err.message);
            } else {
                console.log(' user_chat_usage索引就绪');
            }
        });

        // ==================== VIP会员系统字段 ====================
        // 会员等级: free / Pro / MAX
        db.run(`ALTER TABLE users ADD COLUMN membership TEXT DEFAULT 'free'`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加membership列失败:`, err.message);
            } else if (!err) {
                console.log(' 已添加membership列到users表');
            }
        });

        // 会员开始时间
        db.run(`ALTER TABLE users ADD COLUMN membership_start DATETIME`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加membership_start列失败:`, err.message);
            }
        });

        // 会员结束时间
        db.run(`ALTER TABLE users ADD COLUMN membership_end DATETIME`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加membership_end列失败:`, err.message);
            }
        });

        // 当前点数（每日发放，用完即止）
        db.run(`ALTER TABLE users ADD COLUMN points INTEGER DEFAULT 0`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加points列失败:`, err.message);
            } else if (!err) {
                console.log(' 已添加points列到users表');
            }
        });

        // 上次签到日期（free用户签到用）
        db.run(`ALTER TABLE users ADD COLUMN last_checkin DATE`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加last_checkin列失败:`, err.message);
            }
        });

        // 购买的点数（长期有效，2年过期）
        db.run(`ALTER TABLE users ADD COLUMN purchased_points INTEGER DEFAULT 0`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加purchased_points列失败:`, err.message);
            }
        });

        // 购买点数过期时间
        db.run(`ALTER TABLE users ADD COLUMN purchased_points_expire DATETIME`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加purchased_points_expire列失败:`, err.message);
            }
        });

        // 上次每日点数发放日期（Pro/MAX自动发放用）
        db.run(`ALTER TABLE users ADD COLUMN last_daily_grant DATE`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加last_daily_grant列失败:`, err.message);
            }
        });

        // 旧限免模型使用日期（保留数据库列兼容历史账号）
        db.run(`ALTER TABLE users ADD COLUMN gpt55_usage_date DATE`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加gpt55_usage_date列失败:`, err.message);
            }
        });

        // 旧限免模型使用次数（保留数据库列兼容历史账号）
        db.run(`ALTER TABLE users ADD COLUMN gpt55_usage_count INTEGER DEFAULT 0`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加gpt55_usage_count列失败:`, err.message);
            }
        });

        console.log(' VIP会员系统字段就绪');
    });
});

function buildAllowedCorsOrigins() {
    const origins = new Set([
        'http://localhost:3009',
        'http://127.0.0.1:3009',
        'http://localhost:3010',
        'http://127.0.0.1:3010',
        'tauri://localhost',
        'http://tauri.localhost',
        'https://tauri.localhost'
    ]);

    for (const raw of [PUBLIC_BASE_URL, process.env.CORS_ORIGINS]) {
        if (!raw) continue;
        for (const value of String(raw).split(',')) {
            const trimmed = value.trim();
            if (!trimmed) continue;
            try {
                origins.add(new URL(trimmed).origin);
            } catch (e) {
                origins.add(trimmed);
            }
        }
    }

    return origins;
}

const allowedCorsOrigins = buildAllowedCorsOrigins();
const jsonParser = express.json({ limit: process.env.JSON_BODY_LIMIT || '1mb' });
const chatJsonParser = express.json({ limit: process.env.CHAT_JSON_BODY_LIMIT || '10mb' });

function getRequestHostname(req) {
    const host = String(req.hostname || req.headers.host || '').trim().toLowerCase();
    if (!host) return '';
    if (host.startsWith('[')) {
        const closingBracket = host.indexOf(']');
        return closingBracket >= 0 ? host.slice(1, closingBracket) : host;
    }
    return host.split(':')[0];
}

function isLocalDevelopmentRequest(req) {
    const hostname = getRequestHostname(req);
    return hostname === 'localhost'
        || hostname === '127.0.0.1'
        || hostname === '::1'
        || hostname === 'tauri.localhost';
}

function buildConnectSrcPolicy(req) {
    const sources = ["'self'", 'https:'];
    if (CSP_ALLOW_LOCAL_CONNECT || isLocalDevelopmentRequest(req)) {
        sources.push('http://127.0.0.1:*', 'http://localhost:*', 'ws://127.0.0.1:*', 'ws://localhost:*');
    }
    return `connect-src ${sources.join(' ')}`;
}

function buildScriptSrcPolicy() {
    const sources = ["'self'", 'blob:'];
    if (!CSP_STRICT_SCRIPT_SRC) {
        sources.splice(1, 0, "'unsafe-inline'", "'unsafe-eval'");
    }
    return `script-src ${sources.join(' ')}`;
}

function setSecurityHeaders(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    res.setHeader('Content-Security-Policy', [
        "default-src 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        "frame-ancestors 'self' https://rai.rick.sarl https://rai.rick.quest https://rai.000339.xyz",
        buildScriptSrcPolicy(),
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: https:",
        "font-src 'self' data:",
        buildConnectSrcPolicy(req),
        "media-src 'self' data: blob: https:",
        "worker-src 'self' blob:",
        "manifest-src 'self'",
        "form-action 'self'",
        "frame-src 'self'"
    ].join('; '));

    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').toLowerCase();
    if (req.secure || forwardedProto === 'https') {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
    }
}

// 中间件配置
app.use((req, res, next) => {
    setSecurityHeaders(req, res);
    next();
});

app.use(cors({
    origin(origin, callback) {
        if (!origin || allowedCorsOrigins.has(origin)) return callback(null, true);
        return callback(new Error('CORS origin not allowed'));
    },
    credentials: true
}));
app.use((req, res, next) => {
    if (req.path === '/api/chat/stream') {
        return chatJsonParser(req, res, next);
    }
    return jsonParser(req, res, next);
});
app.use(express.urlencoded({ extended: true, limit: process.env.URLENCODED_BODY_LIMIT || '1mb' }));

app.use((req, res, next) => {
    setSecurityHeaders(req, res);
    next();
});
// 静态资源缓存配置（普通资源 1 天；版本化字体长期缓存）
const staticCacheOptions = {
    maxAge: '1d',
    etag: true,
    lastModified: true,
    setHeaders(res, filePath) {
        const normalizedPath = String(filePath || '').split(path.sep).join('/');
        if (normalizedPath.includes('/public/fonts/')) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            res.setHeader('X-Content-Type-Options', 'nosniff');
        }
    }
};

const avatarStaticOptions = {
    maxAge: '30d',
    immutable: true,
    etag: true,
    lastModified: true,
    setHeaders(res) {
        res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
        res.setHeader('X-Content-Type-Options', 'nosniff');
    }
};

app.use('/avatars', (req, res, next) => {
    const ext = path.extname(req.path).toLowerCase().slice(1);
    if (!['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) {
        return res.status(404).end();
    }
    next();
}, express.static(path.join(__dirname, 'avatars'), avatarStaticOptions));

app.use(GENERATED_IMAGE_PUBLIC_PREFIX, (req, res, next) => {
    const ext = path.extname(req.path).toLowerCase().slice(1);
    if (!['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) {
        return res.status(404).end();
    }
    next();
}, express.static(GENERATED_IMAGES_DIR, avatarStaticOptions));

app.get('/sw.js', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Service-Worker-Allowed', '/');
    res.type('application/javascript');
    res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

app.get('/runtime-config.js', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.type('application/javascript');
    res.send(`window.__RAI_RUNTIME_CONFIG = ${JSON.stringify(buildRuntimeConfigPayload())};\n`);
});

app.get('/site.webmanifest', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.type('application/manifest+json');
    try {
        const manifestPath = path.join(__dirname, 'public', 'site.webmanifest');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        manifest.name = BRAND_TITLE;
        manifest.short_name = BRAND_SHORT_NAME;
        manifest.description = `${BRAND_TITLE} personal AI assistant`;
        res.send(JSON.stringify(manifest, null, 2));
    } catch (error) {
        console.error(' 读取站点清单失败:', error.message);
        res.status(500).json({ error: '读取站点清单失败' });
    }
});

app.use(express.static(path.join(__dirname, 'public'), staticCacheOptions));

// 限流配置
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { error: '登录尝试过多,请15分钟后再试' }
});

const emailAuthLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 8,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: '验证码请求过于频繁，请稍后再试' }
});

const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 100,
    message: { error: '请求过于频繁,请稍后再试' }
});

const CHAT_USAGE_QUOTAS = [
    {
        type: 'minute',
        seconds: 60,
        limit: parseBoundedInteger(process.env.RAI_CHAT_QUOTA_PER_MINUTE, 6, 0, 1000),
        label: '每分钟'
    },
    {
        type: '5h',
        seconds: 5 * 60 * 60,
        limit: parseBoundedInteger(process.env.RAI_CHAT_QUOTA_PER_5H, 120, 0, 10000),
        label: '5小时'
    },
    {
        type: 'week',
        seconds: 7 * 24 * 60 * 60,
        limit: parseBoundedInteger(process.env.RAI_CHAT_QUOTA_PER_WEEK, 800, 0, 100000),
        label: '每周'
    }
];

const financeQuoteLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 30,
    message: { error: '行情请求过于频繁,请稍后再试' }
});

const adminLoginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 8,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: '管理员登录尝试过多,请稍后再试' }
});

const ADMIN_RUNTIME_LIMIT_DEFAULTS = Object.freeze({
    chat_per_minute: parseBoundedInteger(process.env.RAI_CHAT_QUOTA_PER_MINUTE, 6, 0, 1000),
    chat_per_5h: parseBoundedInteger(process.env.RAI_CHAT_QUOTA_PER_5H, 120, 0, 10000),
    chat_per_week: parseBoundedInteger(process.env.RAI_CHAT_QUOTA_PER_WEEK, 800, 0, 100000),
    concurrent_requests: MAX_CONCURRENT_REQUESTS_PER_USER,
    upload_per_minute: parseBoundedInteger(process.env.RAI_UPLOAD_QUOTA_PER_MINUTE, 6, 0, 1000),
    upload_max_file_mb: parseBoundedInteger(process.env.RAI_UPLOAD_MAX_FILE_MB, 20, 1, 50),
    upload_user_total_mb: parseBoundedInteger(process.env.RAI_UPLOAD_USER_TOTAL_MB, 100, 0, 102400),
    upload_user_max_files: parseBoundedInteger(process.env.RAI_UPLOAD_USER_MAX_FILES, 50, 0, 100000),
    pwa_reward_enabled: parseBooleanEnv(process.env.RAI_PWA_REWARD_ENABLED, true) ? 1 : 0,
    pwa_reward_min_account_age_minutes: parseBoundedInteger(process.env.RAI_PWA_REWARD_MIN_ACCOUNT_AGE_MINUTES, 30, 0, 10080),
    invite_reward_immediate_enabled: parseBooleanEnv(process.env.RAI_INVITE_REWARD_IMMEDIATE_ENABLED, false) ? 1 : 0
});

function parseBoundedInteger(value, defaultValue, min, max) {
    const parsed = Number.parseInt(cleanEnvValue(value), 10);
    if (!Number.isFinite(parsed)) return defaultValue;
    return Math.min(Math.max(parsed, min), max);
}

function buildQuotaResetAt(windowStartSeconds, windowSeconds) {
    return new Date((Number(windowStartSeconds || 0) + Number(windowSeconds || 0)) * 1000).toISOString();
}

async function checkAndConsumeChatQuota(userId) {
    const runtimeSettings = await getAdminRuntimeSettings();
    const runtimeQuotas = CHAT_USAGE_QUOTAS.map((quota) => {
        const settingKey = quota.type === 'minute'
            ? 'chat_per_minute'
            : (quota.type === '5h' ? 'chat_per_5h' : 'chat_per_week');
        return {
            ...quota,
            limit: Number(runtimeSettings[settingKey] ?? quota.limit)
        };
    });
    const enabledQuotas = runtimeQuotas.filter((quota) => Number(quota.limit || 0) > 0);
    if (!enabledQuotas.length) {
        return { allowed: true, quotas: [] };
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const windows = enabledQuotas.map((quota) => ({
        ...quota,
        windowStart: Math.floor(nowSeconds / quota.seconds) * quota.seconds
    }));

    await dbRunAsync('BEGIN IMMEDIATE TRANSACTION');
    try {
        const currentRows = [];
        for (const quota of windows) {
            const row = await dbGetAsync(
                `SELECT usage_count
                 FROM user_chat_usage
                 WHERE user_id = ? AND window_type = ? AND window_start = ?`,
                [userId, quota.type, quota.windowStart]
            );
            const used = Number(row?.usage_count || 0);
            currentRows.push({
                ...quota,
                used,
                remaining: Math.max(0, quota.limit - used),
                resetAt: buildQuotaResetAt(quota.windowStart, quota.seconds)
            });
        }

        const blocked = currentRows.find((quota) => quota.used >= quota.limit);
        if (blocked) {
            await dbRunAsync('COMMIT');
            return {
                allowed: false,
                blocked,
                quotas: currentRows.map((quota) => ({
                    type: quota.type,
                    label: quota.label,
                    limit: quota.limit,
                    used: quota.used,
                    remaining: quota.remaining,
                    resetAt: quota.resetAt
                }))
            };
        }

        const consumedRows = [];
        for (const quota of currentRows) {
            const nextUsed = quota.used + 1;
            await dbRunAsync(
                `INSERT INTO user_chat_usage (user_id, window_type, window_start, usage_count, updated_at)
                 VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP)
                 ON CONFLICT(user_id, window_type, window_start)
                 DO UPDATE SET usage_count = usage_count + 1, updated_at = CURRENT_TIMESTAMP`,
                [userId, quota.type, quota.windowStart]
            );
            consumedRows.push({
                type: quota.type,
                label: quota.label,
                limit: quota.limit,
                used: nextUsed,
                remaining: Math.max(0, quota.limit - nextUsed),
                resetAt: quota.resetAt
            });
        }

        await dbRunAsync('COMMIT');
        return { allowed: true, quotas: consumedRows };
    } catch (error) {
        await dbRunAsync('ROLLBACK').catch(() => null);
        throw error;
    }
}

function getBearerToken(req) {
    const authHeader = String(req.headers.authorization || '').trim();
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : '';
}

// JWT验证中间件
const authenticateToken = (req, res, next) => {
    const token = getBearerToken(req);

    if (!token) {
        return res.status(401).json({ error: '未提供认证令牌' });
    }

    try {
        const user = verifyUserSessionToken(token, JWT_SECRET);
        req.user = user;
        next();
    } catch (error) {
        return res.status(403).json({ error: '令牌无效或已过期' });
    }
};

const sessionStreamStates = new Map();
const sessionStreamSubscribers = new Map();

function getSessionStreamSubscribers(sessionId) {
    const key = String(sessionId || '');
    if (!key) return new Set();
    if (!sessionStreamSubscribers.has(key)) {
        sessionStreamSubscribers.set(key, new Set());
    }
    return sessionStreamSubscribers.get(key);
}

function getSessionStreamState(sessionId, requestId, userId) {
    if (!sessionId || !requestId || !userId) return null;
    const key = String(sessionId);
    let state = sessionStreamStates.get(key);
    if (!state || state.requestId !== requestId) {
        state = {
            requestId,
            userId,
            sessionId: key,
            userContent: '',
            assistantContent: '',
            reasoningContent: '',
            model: '',
            status: 'running',
            updatedAt: Date.now(),
            lastPersistAt: 0,
            subscribers: new Set()
        };
        sessionStreamStates.set(key, state);
    }
    return state;
}

function sendSessionStreamEvent(subscriber, payload) {
    if (!subscriber || subscriber.destroyed || subscriber.writableEnded) return false;
    try {
        subscriber.write(`data: ${JSON.stringify(payload)}\n\n`);
        return true;
    } catch (error) {
        return false;
    }
}

function broadcastSessionStreamState(state, eventType = 'session_stream_snapshot') {
    if (!state) return;
    const payload = {
        type: eventType,
        requestId: state.requestId,
        sessionId: state.sessionId,
        userContent: state.userContent || '',
        content: state.assistantContent || '',
        reasoningContent: state.reasoningContent || '',
        model: state.model || '',
        status: state.status || 'running',
        updatedAt: new Date(state.updatedAt || Date.now()).toISOString()
    };

    const subscribers = new Set([
        ...Array.from(state.subscribers || []),
        ...Array.from(getSessionStreamSubscribers(state.sessionId))
    ]);

    for (const subscriber of Array.from(subscribers)) {
        if (!sendSessionStreamEvent(subscriber, payload)) {
            state.subscribers.delete(subscriber);
            getSessionStreamSubscribers(state.sessionId).delete(subscriber);
        }
    }
}

async function persistSessionStreamDraft(state, force = false) {
    if (!state?.sessionId || !state?.requestId) return;
    const now = Date.now();
    if (!force && now - Number(state.lastPersistAt || 0) < 800) return;
    state.lastPersistAt = now;
    await dbRunAsync(
        `INSERT INTO stream_drafts
            (request_id, user_id, session_id, user_content, assistant_content, reasoning_content, model, status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(request_id) DO UPDATE SET
            user_content = excluded.user_content,
            assistant_content = excluded.assistant_content,
            reasoning_content = excluded.reasoning_content,
            model = excluded.model,
            status = excluded.status,
            updated_at = CURRENT_TIMESTAMP`,
        [
            state.requestId,
            state.userId,
            state.sessionId,
            state.userContent || '',
            state.assistantContent || '',
            state.reasoningContent || '',
            state.model || '',
            state.status || 'running'
        ]
    ).catch((error) => {
        console.warn(' 保存流式草稿失败:', error.message);
    });
}

function cleanupSessionStreamState(sessionId, requestId) {
    setTimeout(() => {
        const key = String(sessionId || '');
        const state = sessionStreamStates.get(key);
        if (state && state.requestId === requestId && state.subscribers.size === 0) {
            sessionStreamStates.delete(key);
        }
        const subscribers = sessionStreamSubscribers.get(key);
        if (subscribers && subscribers.size === 0) {
            sessionStreamSubscribers.delete(key);
        }
    }, 30000);
}



async function registerActiveRequestForUser({ requestId, userId, sessionId, limit }) {
    const numericLimit = Math.max(1, Number(limit || MAX_CONCURRENT_REQUESTS_PER_USER));
    await dbRunAsync('BEGIN IMMEDIATE TRANSACTION');
    try {
        const row = await dbGetAsync(
            `SELECT COUNT(*) AS count
             FROM active_requests
             WHERE user_id = ?
               AND COALESCE(is_cancelled, 0) = 0
               AND created_at > datetime('now', '-10 minutes')`,
            [userId]
        );
        const active = Number(row?.count || 0);
        if (active >= numericLimit) {
            await dbRunAsync('COMMIT');
            return { allowed: false, active, limit: numericLimit };
        }

        await dbRunAsync(
            'INSERT INTO active_requests (id, user_id, session_id) VALUES (?, ?, ?)',
            [requestId, userId, sessionId || 'anonymous']
        );
        await dbRunAsync('COMMIT');
        return { allowed: true, active: active + 1, limit: numericLimit };
    } catch (error) {
        await dbRunAsync('ROLLBACK').catch(() => null);
        throw error;
    }
}

// 文件上传配置
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadPath = file.fieldname === 'avatar' ? 'avatars' : 'uploads';
        cb(null, path.join(__dirname, uploadPath));
    },
    filename: (req, file, cb) => {
        const uniqueName = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${path.extname(file.originalname)}`;
        cb(null, uniqueName);
    }
});

const BLOCKED_UPLOAD_EXTENSIONS = new Set([
    'svg', 'exe', 'dll', 'msi',
    'jar', 'com', 'scr', 'vbs', 'wsf',
    'ps1', 'bat', 'cmd'
]);
const TEXTUAL_ATTACHMENT_EXTENSIONS = new Set([
    'txt', 'md', 'json', 'xml', 'csv', 'log', 'yaml', 'yml', 'ini', 'conf',
    'html', 'htm', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx',
    'py', 'java', 'c', 'cpp', 'h', 'hpp', 'css', 'scss', 'less',
    'vue', 'svelte', 'swift', 'kt', 'go', 'rs', 'sh', 'bash', 'zsh', 'sql', 'php', 'pl', 'rb'
]);
const AVATAR_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);
const ATTACHMENT_EXTENSIONS = new Set([
    'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'ico', 'tiff', 'heic', 'heif',
    'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
    'txt', 'md', 'json', 'xml', 'csv', 'log', 'yaml', 'yml', 'ini', 'conf',
    'html', 'htm', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx',
    'py', 'java', 'c', 'cpp', 'h', 'hpp', 'css', 'scss', 'less',
    'vue', 'svelte', 'swift', 'kt', 'go', 'rs',
    'sh', 'bash', 'zsh', 'sql', 'php', 'pl', 'rb',
    'mp4', 'webm', 'mkv', 'flv', 'wmv', 'avi', 'mov', 'm4v',
    'mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac', 'wma', 'opus'
]);

function getUploadExtension(file) {
    return path.extname(file.originalname || '').toLowerCase().slice(1);
}

function filenameHasBlockedExtension(file) {
    const parts = path.basename(String(file?.originalname || '')).toLowerCase().split('.').filter(Boolean);
    if (parts.length <= 1) return false;
    return parts.slice(0, -1).some((part) => BLOCKED_UPLOAD_EXTENSIONS.has(part));
}

function validateAvatarUpload(req, file, cb) {
    const ext = getUploadExtension(file);
    if (filenameHasBlockedExtension(file) || !AVATAR_EXTENSIONS.has(ext)) {
        return cb(new Error('头像仅支持 jpg/png/webp/gif 图片'));
    }
    if (!/^image\/(jpeg|png|gif|webp)$/i.test(file.mimetype || '')) {
        return cb(new Error('头像 MIME 类型不合法'));
    }
    return cb(null, true);
}

function validateAttachmentUpload(req, file, cb) {
    const ext = getUploadExtension(file);
    if (!ext || filenameHasBlockedExtension(file) || BLOCKED_UPLOAD_EXTENSIONS.has(ext) || !ATTACHMENT_EXTENSIONS.has(ext)) {
        return cb(new Error('不支持的文件类型'));
    }
    // 仅拒绝真正的可执行 MIME，代码/HTML 文件允许作为文本附件上传
    if (/x-msdownload|x-msdos-program|x-msi/i.test(file.mimetype || '')) {
        return cb(new Error('不支持的文件类型'));
    }
    return cb(null, true);
}

function runUpload(middleware, req, res, next) {
    middleware(req, res, (err) => {
        if (!err) return next();
        if (err instanceof multer.MulterError) {
            const message = err.code === 'LIMIT_FILE_SIZE' ? '文件大小超过限制' : '文件上传失败';
            return res.status(400).json({ error: message });
        }
        return res.status(400).json({ error: err.message || '文件上传失败' });
    });
}

function hasImageMagic(buffer, ext) {
    const value = String(ext || '').toLowerCase();
    if (value === 'jpg' || value === 'jpeg') {
        return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    }
    if (value === 'png') {
        return buffer.length >= 8 && buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    }
    if (value === 'gif') {
        const signature = buffer.slice(0, 6).toString('ascii');
        return signature === 'GIF87a' || signature === 'GIF89a';
    }
    if (value === 'webp') {
        return buffer.length >= 12
            && buffer.slice(0, 4).toString('ascii') === 'RIFF'
            && buffer.slice(8, 12).toString('ascii') === 'WEBP';
    }
    return true;
}

async function readFilePrefix(filePath, maxBytes = 4096) {
    const handle = await fs.promises.open(filePath, 'r');
    try {
        const buffer = Buffer.alloc(maxBytes);
        const result = await handle.read(buffer, 0, maxBytes, 0);
        return buffer.slice(0, result.bytesRead);
    } finally {
        await handle.close();
    }
}

function looksLikeActiveWebContent(buffer) {
    const text = buffer.toString('utf8').replace(/\0/g, '').trimStart();
    return /^(?:<!doctype\s+html\b|<html\b|<head\b|<body\b|<script\b|<svg\b|<iframe\b|<object\b|<embed\b|<form\b|<\?php\b)/i.test(text);
}

function isTextualAttachmentExtension(ext) {
    return TEXTUAL_ATTACHMENT_EXTENSIONS.has(String(ext || '').toLowerCase());
}

async function validateUploadedFileContent(file, uploadKind) {
    const ext = getUploadExtension(file);
    const prefix = await readFilePrefix(file.path);

    if (uploadKind === 'avatar' && !hasImageMagic(prefix, ext)) {
        const error = new Error('头像文件内容与类型不匹配');
        error.statusCode = 400;
        throw error;
    }

    if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext) && !hasImageMagic(prefix, ext)) {
        const error = new Error('文件内容与扩展名不匹配');
        error.statusCode = 400;
        throw error;
    }

    if (looksLikeActiveWebContent(prefix) && (uploadKind !== 'attachment' || !isTextualAttachmentExtension(ext))) {
        const error = new Error('不支持的文件类型');
        error.statusCode = 400;
        throw error;
    }
}

function normalizeForwardedPrefix(req) {
    const raw = String(req.headers['x-forwarded-prefix'] || '').trim().replace(/\/+$/, '');
    if (!raw) return '';
    if (!/^\/[A-Za-z0-9/_-]{1,80}$/.test(raw) || raw.includes('..')) return '';
    return raw;
}

async function recordUploadedFile(req, file, uploadKind = 'attachment') {
    await dbRunAsync(
        `INSERT OR REPLACE INTO file_uploads
         (filename, user_id, original_name, mime_type, size, upload_kind, created_at)
         VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [
            file.filename,
            req.user.userId,
            String(file.originalname || '').slice(0, 255),
            String(file.mimetype || '').slice(0, 120),
            Number(file.size || 0),
            uploadKind
        ]
    );
}

async function checkAndConsumeWindowUsage({ userId, windowType, seconds, limit, label }) {
    const numericLimit = Number(limit || 0);
    if (numericLimit <= 0) return { allowed: true, limit: numericLimit };
    const nowSeconds = Math.floor(Date.now() / 1000);
    const windowStart = Math.floor(nowSeconds / seconds) * seconds;
    await dbRunAsync('BEGIN IMMEDIATE TRANSACTION');
    try {
        await dbRunAsync(
            `INSERT INTO user_chat_usage (user_id, window_type, window_start, usage_count, updated_at)
             VALUES (?, ?, ?, 0, CURRENT_TIMESTAMP)
             ON CONFLICT(user_id, window_type, window_start) DO NOTHING`,
            [userId, windowType, windowStart]
        );
        const row = await dbGetAsync(
            `SELECT usage_count FROM user_chat_usage
             WHERE user_id = ? AND window_type = ? AND window_start = ?`,
            [userId, windowType, windowStart]
        );
        const used = Number(row?.usage_count || 0);
        if (used >= numericLimit) {
            await dbRunAsync('COMMIT');
            return {
                allowed: false,
                label,
                limit: numericLimit,
                used,
                resetAt: buildQuotaResetAt(windowStart, seconds)
            };
        }
        await dbRunAsync(
            `UPDATE user_chat_usage
             SET usage_count = usage_count + 1, updated_at = CURRENT_TIMESTAMP
             WHERE user_id = ? AND window_type = ? AND window_start = ?`,
            [userId, windowType, windowStart]
        );
        await dbRunAsync('COMMIT');
        return {
            allowed: true,
            label,
            limit: numericLimit,
            used: used + 1,
            remaining: Math.max(numericLimit - used - 1, 0),
            resetAt: buildQuotaResetAt(windowStart, seconds)
        };
    } catch (error) {
        await dbRunAsync('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function getUserUploadStats(userId) {
    const row = await dbGetAsync(
        `SELECT COUNT(*) AS file_count, COALESCE(SUM(size), 0) AS total_size
         FROM file_uploads
         WHERE user_id = ? AND upload_kind = 'attachment'`,
        [userId]
    );
    return {
        fileCount: Number(row?.file_count || 0),
        totalSize: Number(row?.total_size || 0)
    };
}

async function assertUserUploadQuota(userId, incomingBytes = 0) {
    const settings = await getAdminRuntimeSettings();
    const maxFileBytes = Math.max(1, Number(settings.upload_max_file_mb || 20)) * 1024 * 1024;
    const maxTotalBytes = Number(settings.upload_user_total_mb || 0) > 0
        ? Number(settings.upload_user_total_mb) * 1024 * 1024
        : 0;
    const maxFiles = Number(settings.upload_user_max_files || 0);
    const incoming = Number(incomingBytes || 0);

    if (incoming > maxFileBytes) {
        const err = new Error(`单个文件不能超过 ${settings.upload_max_file_mb}MB`);
        err.statusCode = 413;
        throw err;
    }

    const stats = await getUserUploadStats(userId);
    if (maxFiles > 0 && stats.fileCount + 1 > maxFiles) {
        const err = new Error(`上传文件数量已达上限（${maxFiles} 个）`);
        err.statusCode = 429;
        throw err;
    }
    if (maxTotalBytes > 0 && stats.totalSize + incoming > maxTotalBytes) {
        const err = new Error(`上传空间已达上限（${settings.upload_user_total_mb}MB）`);
        err.statusCode = 413;
        throw err;
    }
}

async function userCanAccessUploadedFile(filename, userId) {
    const owner = await dbGetAsync(
        'SELECT user_id FROM file_uploads WHERE filename = ?',
        [filename]
    );
    if (owner) return Number(owner.user_id) === Number(userId);

    // Legacy fallback for files uploaded before file_uploads existed.
    const referenced = await dbGetAsync(
        `SELECT 1 AS ok
         FROM messages m
         JOIN sessions s ON m.session_id = s.id
         WHERE s.user_id = ? AND instr(COALESCE(m.attachments, ''), ?) > 0
         LIMIT 1`,
        [userId, filename]
    );
    return Boolean(referenced);
}

const ACCOUNT_DELETE_CONFIRMATIONS = new Set([
    '注销账号',
    '註銷帳號',
    '删除账号',
    '刪除帳號',
    'DELETE'
]);

function addOwnedFileDeleteTarget(targets, rootDir, filename) {
    const safeFilename = path.basename(String(filename || ''));
    if (!safeFilename || safeFilename === '.' || safeFilename === '..') return;
    const safeRoot = rootDir === 'avatars' ? 'avatars' : 'uploads';
    targets.set(`${safeRoot}:${safeFilename}`, { rootDir: safeRoot, filename: safeFilename });
}

function addAvatarDeleteTargetFromUrl(targets, avatarUrl) {
    const rawUrl = String(avatarUrl || '').trim();
    if (!rawUrl) return;
    const match = rawUrl.match(/\/avatars\/([^/?#]+)/i);
    if (!match) return;
    addOwnedFileDeleteTarget(targets, 'avatars', decodeURIComponent(match[1]));
}

async function unlinkOwnedUserFiles(fileTargets) {
    let deletedFiles = 0;
    for (const target of fileTargets) {
        const rootPath = path.resolve(__dirname, target.rootDir);
        const filePath = path.resolve(rootPath, path.basename(target.filename || ''));
        if (!filePath.startsWith(`${rootPath}${path.sep}`)) continue;
        try {
            await fs.promises.unlink(filePath);
            deletedFiles += 1;
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.warn(` 删除用户文件失败: ${target.rootDir}/${target.filename}`, error.message);
            }
        }
    }
    return deletedFiles;
}

async function deleteUserDataCascade(userId, options = {}) {
    const numericUserId = Number(userId);
    if (!Number.isInteger(numericUserId) || numericUserId <= 0) {
        const error = new Error('invalid_user_id');
        error.statusCode = 400;
        throw error;
    }

    const user = await dbGetAsync(
        'SELECT id, email, avatar_url FROM users WHERE id = ?',
        [numericUserId]
    );
    if (!user) {
        return { success: false, notFound: true, deletedUserId: numericUserId, deletedUploads: 0, deletedFiles: 0 };
    }

    const uploads = await dbAllAsync(
        'SELECT filename, upload_kind FROM file_uploads WHERE user_id = ?',
        [numericUserId]
    );
    const fileTargets = new Map();
    uploads.forEach((upload) => {
        addOwnedFileDeleteTarget(
            fileTargets,
            String(upload.upload_kind || '') === 'avatar' ? 'avatars' : 'uploads',
            upload.filename
        );
    });
    addAvatarDeleteTargetFromUrl(fileTargets, user.avatar_url);

    await dbRunAsync('BEGIN IMMEDIATE TRANSACTION');
    try {
        await dbRunAsync('DELETE FROM message_feedback WHERE user_id = ?', [numericUserId]);
        await dbRunAsync('DELETE FROM stream_drafts WHERE user_id = ?', [numericUserId]);
        await dbRunAsync('DELETE FROM active_requests WHERE user_id = ?', [numericUserId]);
        await dbRunAsync('DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE user_id = ?)', [numericUserId]);
        await dbRunAsync('DELETE FROM flows WHERE user_id = ?', [numericUserId]);
        await dbRunAsync('DELETE FROM sessions WHERE user_id = ?', [numericUserId]);
        await dbRunAsync('DELETE FROM user_memories WHERE user_id = ?', [numericUserId]);
        await dbRunAsync('DELETE FROM user_configs WHERE user_id = ?', [numericUserId]);
        await dbRunAsync('DELETE FROM device_fingerprints WHERE user_id = ?', [numericUserId]);
        await dbRunAsync('DELETE FROM user_task_rewards WHERE user_id = ?', [numericUserId]);
        await dbRunAsync('DELETE FROM user_chat_usage WHERE user_id = ?', [numericUserId]);
        await dbRunAsync('DELETE FROM file_uploads WHERE user_id = ?', [numericUserId]);
        await dbRunAsync('DELETE FROM auth_ztx6d_codes WHERE user_id = ?', [numericUserId]);
        await dbRunAsync('DELETE FROM auth_ztx6d_rt WHERE bind_user_id = ?', [numericUserId]);
        await dbRunAsync('DELETE FROM auth_email_codes WHERE user_id = ? OR LOWER(email) = LOWER(?)', [numericUserId, user.email || '']);
        await dbRunAsync('DELETE FROM user_two_factor_setup_challenges WHERE user_id = ?', [numericUserId]);
        await dbRunAsync('UPDATE users SET pending_referrer_id = NULL WHERE pending_referrer_id = ?', [numericUserId]);

        const result = await dbRunAsync('DELETE FROM users WHERE id = ?', [numericUserId]);
        if (result.changes === 0) {
            await dbRunAsync('ROLLBACK');
            return { success: false, notFound: true, deletedUserId: numericUserId, deletedUploads: 0, deletedFiles: 0 };
        }

        await dbRunAsync('COMMIT');
    } catch (error) {
        await dbRunAsync('ROLLBACK').catch(() => null);
        throw error;
    }

    const deletedFiles = await unlinkOwnedUserFiles(fileTargets.values());
    return {
        success: true,
        actor: options.actor || 'system',
        deletedUserId: numericUserId,
        deletedUploads: uploads.length,
        deletedFiles
    };
}

const avatarUpload = multer({
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: validateAvatarUpload
});

const attachmentUpload = multer({
    storage: storage,
    limits: { fileSize: ATTACHMENT_UPLOAD_HARD_LIMIT_BYTES },
    fileFilter: validateAttachmentUpload
});

// ==================== 测试路由 ====================
app.get('/api/test', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.json({
        success: true,
        message: 'RAI API v3.2 正常运行',
        version: PACKAGE_VERSION,
        timestamp: new Date().toISOString()
    });
});

app.get('/api/version', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.json({
        success: true,
        version: PACKAGE_VERSION,
        timestamp: new Date().toISOString()
    });
});

app.get('/api/quote/:symbol', financeQuoteLimiter, async (req, res) => {
    try {
        const quote = await fetchYahooFinanceQuote({
            symbol: req.params.symbol,
            range: req.query.range || FINANCE_DEFAULT_RANGE,
            interval: req.query.interval || FINANCE_DEFAULT_INTERVAL
        });
        res.json(quote);
    } catch (error) {
        const statusCode = Number(error?.statusCode || 502);
        res.status(statusCode).json({
            error: {
                code: error?.code || 'finance_quote_failed',
                message: error?.message || '获取行情失败',
                details: error?.details || null
            }
        });
    }
});

function isZtx6dEnabled() {
    if (ZTX6D_FORCE_DISABLED) return false;
    return /^\d+$/.test(String(ZTX6D_APP_ID || '').trim()) && !!ZTX6D_APP_KEY;
}

function getZtx6dConfigError() {
    if (ZTX6D_FORCE_DISABLED) return 'disabled_by_invalid_credentials';
    if (!ZTX6D_APP_ID || !ZTX6D_APP_KEY) return 'missing_app_config';
    if (!/^\d+$/.test(String(ZTX6D_APP_ID || '').trim())) return 'invalid_app_id';
    return '';
}

function resolvePublicBaseUrl(req) {
    if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL.replace(/\/+$/, '');
    const protocol = req.protocol || 'https';
    const host = req.get('host') || 'rai.rick.sarl';
    return `${protocol}://${host}`;
}

function resolveZtx6dCallbackUrl(req) {
    const publicBase = resolvePublicBaseUrl(req);
    if (ZTX6D_CALLBACK_URL) {
        try {
            const configured = new URL(ZTX6D_CALLBACK_URL);
            const publicUrl = new URL(publicBase);
            const publicPath = publicUrl.pathname.replace(/\/+$/, '');
            const configuredPath = configured.pathname.replace(/\/+$/, '');
            if (publicPath && publicPath !== '/' && configured.origin === publicUrl.origin && !configuredPath.startsWith(`${publicPath}/`)) {
                return `${publicBase}/api/auth/ztx6d/callback`;
            }
        } catch (error) {
            console.warn(` ZTX6D_CALLBACK_URL格式无效，使用PUBLIC_BASE_URL生成回调: ${error.message}`);
            return `${publicBase}/api/auth/ztx6d/callback`;
        }
        return ZTX6D_CALLBACK_URL;
    }
    return `${publicBase}/api/auth/ztx6d/callback`;
}

function normalizeReturnPath(value = '/') {
    const raw = String(value || '/').trim();
    if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '/';
    return raw;
}

function buildClientAuthRedirect(req, returnPath, params = {}) {
    const publicUrl = new URL(resolvePublicBaseUrl(req));
    const basePath = publicUrl.pathname.replace(/\/+$/, '');
    const targetUrl = new URL(normalizeReturnPath(returnPath), `${publicUrl.origin}/`);
    if (basePath && basePath !== '/' && targetUrl.origin === publicUrl.origin && !(targetUrl.pathname === basePath || targetUrl.pathname.startsWith(`${basePath}/`))) {
        targetUrl.pathname = `${basePath}${targetUrl.pathname === '/' ? '/' : targetUrl.pathname}`;
    }
    const url = new URL(targetUrl.toString());
    Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '') {
            url.searchParams.set(key, String(value));
        }
    });
    return url.toString();
}

async function fetchZtx6dOpenApi(action, payload) {
    const url = new URL(ZTX6D_API_URL);
    url.searchParams.set('action', action);

    const response = await fetch(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    let data = null;
    const text = await response.text();
    if (text) {
        try {
            data = JSON.parse(text);
        } catch (error) {
            throw new Error(`ztx6d_invalid_json:${text.substring(0, 160)}`);
        }
    }

    if (!response.ok || data?.error) {
        const code = data?.error || `http_${response.status}`;
        const error = new Error(`ztx6d_${action}_${code}`);
        error.code = code;
        error.statusCode = response.status || 502;
        throw error;
    }

    return data || {};
}

async function cleanupExpiredZtx6dRt() {
    try {
        await dbRunAsync(
            'DELETE FROM auth_ztx6d_rt WHERE expires_at < ? OR (consumed_at IS NOT NULL AND consumed_at < ?)',
            [Date.now(), Date.now() - 24 * 60 * 60 * 1000]
        );
    } catch (error) {
        console.warn(` ZTX6D rt清理失败: ${error.message}`);
    }
}

async function consumeZtx6dRt(rt) {
    const authRt = String(rt || '').trim();
    if (!authRt) return null;
    await dbRunAsync('BEGIN IMMEDIATE TRANSACTION');
    try {
        const row = await dbGetAsync('SELECT * FROM auth_ztx6d_rt WHERE rt = ?', [authRt]);
        if (!row || row.consumed_at || Number(row.expires_at || 0) < Date.now()) {
            await dbRunAsync('COMMIT');
            return null;
        }

        const result = await dbRunAsync(
            'UPDATE auth_ztx6d_rt SET consumed_at = ? WHERE rt = ? AND consumed_at IS NULL',
            [Date.now(), authRt]
        );
        if (Number(result?.changes || 0) !== 1) {
            await dbRunAsync('ROLLBACK');
            return null;
        }

        await dbRunAsync('COMMIT');
        return row;
    } catch (error) {
        await dbRunAsync('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function cleanupExpiredZtx6dAuthCodes() {
    try {
        await dbRunAsync(
            'DELETE FROM auth_ztx6d_codes WHERE expires_at < ? OR (consumed_at IS NOT NULL AND consumed_at < ?)',
            [Date.now(), Date.now() - 24 * 60 * 60 * 1000]
        );
    } catch (error) {
        console.warn(` ZTX6D auth_code清理失败: ${error.message}`);
    }
}

async function createZtx6dAuthCode(user, returnPath = '/') {
    const userId = Number(user?.id || 0);
    const email = String(user?.email || '').trim();
    if (!Number.isInteger(userId) || userId <= 0 || !email) {
        throw new Error('invalid_ztx6d_auth_code_user');
    }

    await cleanupExpiredZtx6dAuthCodes();
    const code = crypto.randomBytes(32).toString('base64url');
    await dbRunAsync(
        `INSERT INTO auth_ztx6d_codes
         (code, user_id, email, provider, return_path, created_at, expires_at, consumed_at)
         VALUES (?, ?, ?, 'ztx6d', ?, ?, ?, NULL)`,
        [code, userId, email, normalizeReturnPath(returnPath), Date.now(), Date.now() + ZTX6D_AUTH_CODE_TTL_MS]
    );
    return code;
}

async function consumeZtx6dAuthCode(code) {
    const authCode = String(code || '').trim();
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(authCode)) return null;

    await dbRunAsync('BEGIN IMMEDIATE TRANSACTION');
    try {
        const row = await dbGetAsync(
            'SELECT * FROM auth_ztx6d_codes WHERE code = ?',
            [authCode]
        );

        if (!row || row.consumed_at || Number(row.expires_at || 0) < Date.now()) {
            await dbRunAsync('COMMIT');
            return null;
        }

        const result = await dbRunAsync(
            'UPDATE auth_ztx6d_codes SET consumed_at = ? WHERE code = ? AND consumed_at IS NULL',
            [Date.now(), authCode]
        );
        if (Number(result?.changes || 0) !== 1) {
            await dbRunAsync('ROLLBACK');
            return null;
        }

        await dbRunAsync('COMMIT');
        return row;
    } catch (error) {
        await dbRunAsync('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function findOrCreateZtx6dUser(uid) {
    const externalUid = String(uid || '').trim();
    if (!externalUid) {
        throw new Error('missing_ztx6d_uid');
    }

    const provider = 'ztx6d';
    const syntheticEmail = `ztx6d-${externalUid}@passport.ztx6d.local`;
    const username = buildProviderUsername('ztx6d', externalUid);

    let user = await dbGetAsync(
        'SELECT id, email, username, avatar_url FROM users WHERE external_provider = ? AND external_uid = ?',
        [provider, externalUid]
    );

    if (!user) {
        const existingSyntheticUser = await dbGetAsync(
            'SELECT id, email, username, avatar_url FROM users WHERE email = ?',
            [syntheticEmail]
        );

        if (existingSyntheticUser) {
            await dbRunAsync(
                'UPDATE users SET external_provider = ?, external_uid = ?, last_login = CURRENT_TIMESTAMP WHERE id = ?',
                [provider, externalUid, existingSyntheticUser.id]
            );
            user = { ...existingSyntheticUser, username: existingSyntheticUser.username || username };
        } else {
            const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
            const result = await dbRunAsync(
                `INSERT INTO users
                 (email, password_hash, username, email_verified, email_verified_at, external_provider, external_uid, last_login)
                 VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP, ?, ?, CURRENT_TIMESTAMP)`,
                [syntheticEmail, passwordHash, username, provider, externalUid]
            );
            await dbRunAsync('INSERT OR IGNORE INTO user_configs (user_id, long_memory_enabled) VALUES (?, 0)', [result.lastID]);
            await dbRunAsync(
                `UPDATE users SET points = COALESCE(points, 0) + ? WHERE id = ?`,
                [NEW_USER_WELCOME_POINTS, result.lastID]
            ).catch((error) => {
                console.warn(` ztx6d新用户欢迎点数发放失败 userId=${result.lastID}:`, error.message);
            });
            user = {
                id: result.lastID,
                email: syntheticEmail,
                username,
                avatar_url: null
            };
        }
    } else {
        await dbRunAsync('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);
        await dbRunAsync('INSERT OR IGNORE INTO user_configs (user_id, long_memory_enabled) VALUES (?, 0)', [user.id]);
    }

    return user;
}

async function bindZtx6dUser(userId, uid) {
    const targetUserId = Number(userId);
    const externalUid = String(uid || '').trim();
    const provider = 'ztx6d';

    if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
        const error = new Error('invalid_bind_user');
        error.code = 'user_not_found';
        throw error;
    }

    if (!externalUid) {
        const error = new Error('missing_ztx6d_uid');
        error.code = 'missing_uid';
        throw error;
    }

    const existingBinding = await dbGetAsync(
        'SELECT id, email, username, avatar_url FROM users WHERE external_provider = ? AND external_uid = ?',
        [provider, externalUid]
    );

    if (existingBinding && Number(existingBinding.id) !== targetUserId) {
        const error = new Error('ztx6d_uid_already_bound');
        error.code = 'already_bound';
        throw error;
    }

    const user = await dbGetAsync(
        'SELECT id, email, username, avatar_url, external_provider, external_uid FROM users WHERE id = ?',
        [targetUserId]
    );

    if (!user) {
        const error = new Error('bind_user_not_found');
        error.code = 'user_not_found';
        throw error;
    }

    const currentProvider = String(user.external_provider || '').trim();
    const currentUid = String(user.external_uid || '').trim();
    if (currentProvider && (currentProvider !== provider || currentUid !== externalUid)) {
        const error = new Error('local_user_already_bound');
        error.code = 'user_already_bound';
        throw error;
    }

    await dbRunAsync(
        'UPDATE users SET external_provider = ?, external_uid = ?, last_login = CURRENT_TIMESTAMP WHERE id = ?',
        [provider, externalUid, targetUserId]
    );
    await dbRunAsync('INSERT OR IGNORE INTO user_configs (user_id, long_memory_enabled) VALUES (?, 0)', [targetUserId]);

    return {
        id: user.id,
        email: user.email,
        username: user.username,
        avatar_url: user.avatar_url
    };
}

function redirectZtx6dError(req, returnPath, code) {
    const safeCode = String(code || 'auth_failed').replace(/[^a-z0-9_-]/gi, '_').slice(0, 80);
    return buildClientAuthRedirect(req, returnPath, {
        auth_error: `ztx6d_${safeCode}`
    });
}

app.get('/api/auth/ztx6d/status', (req, res) => {
    res.json({
        success: true,
        enabled: isZtx6dEnabled(),
        configError: getZtx6dConfigError(),
        provider: 'ztx6d',
        loginUrl: '/api/auth/ztx6d/start',
        bindUrl: '/api/auth/ztx6d/bind/start',
        callbackUrl: resolveZtx6dCallbackUrl(req)
    });
});

app.get('/api/auth/ztx6d/start', authLimiter, async (req, res) => {
    const returnPath = normalizeReturnPath(req.query.return || '/');

    if (!isZtx6dEnabled()) {
        return res.status(503).json({ success: false, error: 'ztx6d_disabled' });
    }

    try {
        await cleanupExpiredZtx6dRt();
        const data = await fetchZtx6dOpenApi('create_rt', {
            appid: Number(ZTX6D_APP_ID),
            appkey: ZTX6D_APP_KEY
        });
        const rt = String(data?.rt || '').trim();
        if (!rt) {
            return res.status(502).json({ success: false, error: 'ztx6d_missing_rt' });
        }

        await dbRunAsync(
            'INSERT OR REPLACE INTO auth_ztx6d_rt (rt, return_path, created_at, expires_at, consumed_at, bind_user_id) VALUES (?, ?, ?, ?, NULL, NULL)',
            [rt, returnPath, Date.now(), Date.now() + ZTX6D_RT_TTL_MS]
        );

        const loginUrl = new URL(ZTX6D_LOGIN_URL);
        loginUrl.searchParams.set('rt', rt);
        res.redirect(loginUrl.toString());
    } catch (error) {
        console.error(` ZTX6D create_rt失败: ${error.message}`);
        res.status(502).json({ success: false, error: error.code || 'ztx6d_create_rt_failed' });
    }
});

app.post('/api/auth/ztx6d/bind/start', authenticateToken, authLimiter, async (req, res) => {
    const returnPath = normalizeReturnPath(req.body?.return || req.query.return || '/');

    if (!isZtx6dEnabled()) {
        return res.status(503).json({ success: false, error: 'ztx6d_disabled' });
    }

    try {
        await cleanupExpiredZtx6dRt();
        const data = await fetchZtx6dOpenApi('create_rt', {
            appid: Number(ZTX6D_APP_ID),
            appkey: ZTX6D_APP_KEY
        });
        const rt = String(data?.rt || '').trim();
        if (!rt) {
            return res.status(502).json({ success: false, error: 'ztx6d_missing_rt' });
        }

        await dbRunAsync(
            'INSERT OR REPLACE INTO auth_ztx6d_rt (rt, return_path, created_at, expires_at, consumed_at, bind_user_id) VALUES (?, ?, ?, ?, NULL, ?)',
            [rt, returnPath, Date.now(), Date.now() + ZTX6D_RT_TTL_MS, req.user.userId]
        );

        const loginUrl = new URL(ZTX6D_LOGIN_URL);
        loginUrl.searchParams.set('rt', rt);
        res.json({ success: true, redirectUrl: loginUrl.toString() });
    } catch (error) {
        console.error(` ZTX6D bind create_rt失败: ${error.message}`);
        res.status(502).json({ success: false, error: error.code || 'ztx6d_create_rt_failed' });
    }
});

app.get('/api/auth/ztx6d/callback', authLimiter, async (req, res) => {
    const rt = String(req.query.rt || '').trim();
    let returnPath = '/';

    if (!isZtx6dEnabled()) {
        return res.redirect(redirectZtx6dError(req, returnPath, 'disabled'));
    }

    if (!rt) {
        return res.redirect(redirectZtx6dError(req, returnPath, 'missing_rt'));
    }

    try {
        const pending = await consumeZtx6dRt(rt);
        returnPath = normalizeReturnPath(pending?.return_path || '/');

        if (!pending) {
            return res.redirect(redirectZtx6dError(req, returnPath, 'invalid_or_expired_rt'));
        }

        const data = await fetchZtx6dOpenApi('get_rt', {
            appid: Number(ZTX6D_APP_ID),
            appkey: ZTX6D_APP_KEY,
            rt
        });

        const uid = data?.uid;
        if (uid === undefined || uid === null || String(uid).trim() === '') {
            return res.redirect(redirectZtx6dError(req, returnPath, 'missing_uid'));
        }

        const bindUserId = Number(pending.bind_user_id || 0);
        const user = bindUserId > 0
            ? await bindZtx6dUser(bindUserId, uid)
            : await findOrCreateZtx6dUser(uid);
        const authCode = await createZtx6dAuthCode(user, returnPath);

        res.redirect(buildClientAuthRedirect(req, returnPath, {
            auth_code: authCode,
            auth_provider: 'ztx6d'
        }));
    } catch (error) {
        console.error(` ZTX6D callback失败: ${error.message}`);
        res.redirect(redirectZtx6dError(req, returnPath, error.code || 'callback_failed'));
    }
});

app.post('/api/auth/ztx6d/exchange', authLimiter, async (req, res) => {
    const authCode = String(req.body?.auth_code || req.query?.auth_code || '').trim();
    if (!authCode) {
        return res.status(400).json({ success: false, error: 'missing_auth_code' });
    }

    try {
        const codeRecord = await consumeZtx6dAuthCode(authCode);
        if (!codeRecord) {
            return res.status(400).json({ success: false, error: 'invalid_or_expired_auth_code' });
        }

        const token = signUserSessionToken(
            { userId: codeRecord.user_id, email: codeRecord.email },
            JWT_SECRET,
            { provider: codeRecord.provider || 'ztx6d' }
        );

        res.json({
            success: true,
            token,
            auth_provider: codeRecord.provider || 'ztx6d'
        });
    } catch (error) {
        console.error(` ZTX6D auth_code交换失败: ${error.message}`);
        res.status(500).json({ success: false, error: 'auth_code_exchange_failed' });
    }
});

// ==================== 认证路由 ====================
async function buildAuthenticatedUserPayload(user, req, fingerprint = '') {
    await dbRunAsync('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);

    if (fingerprint) {
        await dbRunAsync(
            'INSERT OR REPLACE INTO device_fingerprints (user_id, fingerprint, device_name, last_used) VALUES (?, ?, ?, CURRENT_TIMESTAMP)',
            [user.id, fingerprint, req.headers['user-agent'] || 'Unknown']
        ).catch((error) => {
            console.warn(` 设备指纹记录失败 userId=${user.id}:`, error.message);
        });
    }

    const token = signUserSessionToken(user, JWT_SECRET);
    const sessionRow = await dbGetAsync('SELECT COUNT(*) as cnt FROM sessions WHERE user_id = ?', [user.id])
        .catch(() => ({ cnt: 0 }));
    const isNewUser = !sessionRow || Number(sessionRow.cnt || 0) === 0;

    return {
        success: true,
        token,
        isNewUser,
        user: {
            id: user.id,
            email: user.email,
            username: user.username,
            avatar_url: user.avatar_url || null,
            email_verified: Number(user.email_verified ?? 1) === 1,
            two_factor_enabled: Number(user.two_factor_enabled || 0) === 1
        }
	    };
	}

async function completeRegistrationEmailVerification({ user, req, fingerprint = '', referrerId = '', bypassReason = '' }) {
    const userId = Number(user?.id || 0);
    if (!Number.isInteger(userId) || userId <= 0) {
        throw new Error('invalid_registration_user');
    }

    const pendingReferrer = normalizeReferralUserId(referrerId || user.pending_referrer_id || '');
    await dbRunAsync(
        `UPDATE users
         SET email_verified = 1,
             email_verified_at = CURRENT_TIMESTAMP,
             pending_referrer_id = NULL
         WHERE id = ?`,
        [userId]
    );

    await dbRunAsync(
        `UPDATE users SET points = COALESCE(points, 0) + ? WHERE id = ? AND email_verified = 1`,
        [NEW_USER_WELCOME_POINTS, userId]
    ).catch((error) => {
        console.warn(` 新用户欢迎点数发放失败 userId=${userId}:`, error.message);
    });
    console.log(` 新用户欢迎点数已发放 userId=${userId}, points=+${NEW_USER_WELCOME_POINTS}`);

    if (user.email) {
        sendWelcomeEmail({ email: user.email, username: user.username })
            .then(() => { console.log(` 欢迎邮件已发送 userId=${userId}`); })
            .catch((error) => {
                console.warn(` 欢迎邮件发送失败 userId=${userId}:`, error.message);
                appendRaiRuntimeReport({
                    level: '警告',
                    tag: 'welcome_email_failed',
                    message: '新用户欢迎邮件发送失败',
                    context: { userId, error: error.message }
                });
            });
    }

    await dbRunAsync(
        `UPDATE auth_email_codes
         SET consumed_at = ?
         WHERE LOWER(email) = LOWER(?)
           AND purpose = 'register'
           AND consumed_at IS NULL`,
        [Date.now(), user.email || '']
    ).catch((error) => {
        console.warn(` 注册邮箱验证码清理失败 userId=${userId}:`, error.message);
    });

    let inviteReward = null;
    if (pendingReferrer) {
        try {
            inviteReward = await awardInviteReferralIfValid(pendingReferrer, userId, req);
            if (inviteReward?.awarded) {
                console.log(` 邀请奖励成功: referrer=${pendingReferrer}, invited=${userId}, referrerPoints=${inviteReward.pointsGained || 0}, inviteePoints=${inviteReward.inviteePointsGained || 0}`);
            }
        } catch (inviteError) {
            console.warn(` 邀请奖励失败 referrer=${pendingReferrer}, invited=${userId}:`, inviteError.message);
        }
    }

    if (bypassReason) {
        appendRaiRuntimeReport({
            level: '警告',
            tag: 'email_auth_bypass',
            message: '注册邮箱验证因邮件供应商测试模式限制临时跳过',
            context: {
                userId,
                emailDomain: String(user.email || '').split('@')[1] || '',
                reason: bypassReason
            }
        });
    }

    const updatedUser = await dbGetAsync('SELECT * FROM users WHERE id = ?', [userId]);
    const payload = await buildAuthenticatedUserPayload(updatedUser, req, fingerprint);
    return {
        ...payload,
        isNewUser: true,
        inviteReward,
        email_verified: true,
        emailVerificationBypassed: !!bypassReason,
        message: bypassReason
            ? '邮箱服务临时受限，已先为你创建账号。'
            : undefined
    };
}

app.post('/api/auth/register', authLimiter, emailAuthLimiter, async (req, res) => {
    try {
        const { email, password, username, referrerId, referralCode, ref } = req.body;
        const normalizedReferrerId = normalizeReferralUserId(referrerId || referralCode || ref);
        const normalizedEmail = normalizeEmailForAuth(email);
        const normalizedUsername = typeof username === 'string' ? username.trim() : '';
        const passwordError = validatePasswordLength(password);

        if (!normalizedEmail || !password) {
            return res.status(400).json({ success: false, error: '邮箱和密码不能为空' });
        }

        if (!isValidEmailForAuth(normalizedEmail)) {
            return res.status(400).json({ success: false, error: '邮件格式不正确' });
        }

        const usernameResult = normalizeUsernameForStorage(normalizedUsername);
        if (usernameResult.error) {
            return res.status(400).json({ success: false, error: usernameResult.error });
        }

        if (passwordError) {
            return res.status(400).json({ success: false, error: passwordError });
        }

        const finalUsername = usernameResult.value || buildDefaultUsernameFromEmail(normalizedEmail);
        let user = await dbGetAsync('SELECT * FROM users WHERE LOWER(email) = LOWER(?)', [normalizedEmail]);

        if (user && Number(user.email_verified ?? 1) === 1) {
            return res.status(400).json({ success: false, error: '该邮箱已被注册' });
        }

        if (user) {
            const validPendingPassword = await bcrypt.compare(password, user.password_hash).catch(() => false);
            if (!validPendingPassword) {
                return res.status(400).json({ success: false, error: '该邮箱已被注册' });
            }
            await dbRunAsync(
                `UPDATE users
                 SET username = ?,
                     pending_referrer_id = COALESCE(?, pending_referrer_id)
                 WHERE id = ?`,
                [finalUsername, normalizedReferrerId || null, user.id]
            );
        } else {
            const passwordHash = await bcrypt.hash(password, 10);
            const result = await dbRunAsync(
                `INSERT INTO users
                 (email, password_hash, username, email_verified, pending_referrer_id)
                 VALUES (?, ?, ?, 0, ?)`,
                [normalizedEmail, passwordHash, finalUsername, normalizedReferrerId || null]
            );
            await dbRunAsync('INSERT INTO user_configs (user_id, long_memory_enabled) VALUES (?, 0)', [result.lastID]);
            user = {
                id: result.lastID,
                email: normalizedEmail,
                username: finalUsername
            };
            console.log(' 用户注册待邮箱验证, ID:', user.id);
        }

        const sent = await sendEmailCodeOrReport({
            email: normalizedEmail,
            userId: user.id,
            purpose: 'register',
            metadata: { referrerId: normalizedReferrerId || '' },
            req
	        });
	        if (!sent.ok) {
	            if (shouldBypassResendTestingRestriction(sent.error)) {
	                const payload = await completeRegistrationEmailVerification({
	                    user,
	                    req,
	                    referrerId: normalizedReferrerId || user.pending_referrer_id || '',
	                    bypassReason: 'resend_testing_domain_restricted'
	                });
	                return res.json(payload);
	            }
	            if (isResendTestingRestrictionError(sent.error)) {
	                return res.status(400).json({
	                    success: false,
	                    error: '验证邮件发送失败：邮件服务尚未完成发信域名验证，请联系管理员处理'
	                });
	            }
	            return res.status(502).json({ success: false, error: '验证邮件发送失败，请稍后再试' });
	        }

        return res.json({
            success: true,
            requiresEmailVerification: true,
            email: normalizedEmail,
            message: '验证码已发送到邮箱'
        });
    } catch (error) {
        console.error(' 注册错误:', error);
        res.status(500).json({ success: false, error: '服务器错误' });
    }
});

app.post('/api/auth/register/resend', authLimiter, emailAuthLimiter, async (req, res) => {
    try {
        const normalizedEmail = normalizeEmailForAuth(req.body?.email);
        const password = typeof req.body?.password === 'string' ? req.body.password : '';

        if (!isValidEmailForAuth(normalizedEmail) || validatePasswordLength(password)) {
            return res.status(400).json({ success: false, error: '邮箱和密码不能为空' });
        }

        const user = await dbGetAsync('SELECT * FROM users WHERE LOWER(email) = LOWER(?)', [normalizedEmail]);
        if (!user || Number(user.email_verified ?? 1) === 1) {
            return res.status(400).json({ success: false, error: '该邮箱已被注册' });
        }

        const validPendingPassword = await bcrypt.compare(password, user.password_hash).catch(() => false);
        if (!validPendingPassword) {
            return res.status(400).json({ success: false, error: '该邮箱已被注册' });
        }

        const sent = await sendEmailCodeOrReport({
            email: normalizedEmail,
            userId: user.id,
            purpose: 'register',
            metadata: { referrerId: user.pending_referrer_id || '' },
            req
	        });
	        if (!sent.ok) {
	            if (shouldBypassResendTestingRestriction(sent.error)) {
	                const payload = await completeRegistrationEmailVerification({
	                    user,
	                    req,
	                    referrerId: user.pending_referrer_id || '',
	                    bypassReason: 'resend_testing_domain_restricted'
	                });
	                return res.json(payload);
	            }
	            if (isResendTestingRestrictionError(sent.error)) {
	                return res.status(400).json({
	                    success: false,
	                    error: '验证邮件发送失败：邮件服务尚未完成发信域名验证，请联系管理员处理'
	                });
	            }
	            return res.status(502).json({ success: false, error: '验证邮件发送失败，请稍后再试' });
	        }
        return res.json({ success: true, requiresEmailVerification: true, email: normalizedEmail });
    } catch (error) {
        console.error(' 重发注册验证码失败:', error);
        return res.status(500).json({ success: false, error: '服务器错误' });
    }
});

app.post('/api/auth/register/verify', authLimiter, async (req, res) => {
    try {
        const normalizedEmail = normalizeEmailForAuth(req.body?.email);
        const code = typeof req.body?.code === 'string' ? req.body.code : '';
        const fingerprint = typeof req.body?.fingerprint === 'string' ? req.body.fingerprint : '';

        if (!isValidEmailForAuth(normalizedEmail)) {
            return res.status(400).json({ success: false, error: '邮件格式不正确' });
        }

        const user = await dbGetAsync('SELECT * FROM users WHERE LOWER(email) = LOWER(?)', [normalizedEmail]);
        if (!user) {
            return res.status(404).json({ success: false, error: '用户不存在' });
        }

        if (Number(user.email_verified ?? 1) === 1) {
            return res.status(409).json({ success: false, error: '邮箱已验证，请直接登录' });
        }

        const verification = await verifyAndConsumeEmailCode({
            email: normalizedEmail,
            purpose: 'register',
            code,
            userId: user.id
        });
        if (!verification.ok) {
            return res.status(400).json({ success: false, error: verification.error || '验证码无效或已过期' });
        }

	        const payload = await completeRegistrationEmailVerification({
	            user,
	            req,
	            fingerprint,
	            referrerId: user.pending_referrer_id || verification.metadata?.referrerId || ''
	        });
	        return res.json(payload);
    } catch (error) {
        console.error(' 注册邮箱验证失败:', error);
        res.status(500).json({ success: false, error: '邮箱验证失败' });
    }
});

app.post('/api/auth/login/precheck', authLimiter, async (req, res) => {
    try {
        const normalizedEmail = normalizeEmailForAuth(req.body?.email);
        if (!isValidEmailForAuth(normalizedEmail)) {
            return res.json({ success: true, twoFactorRequired: false });
        }
        const user = await dbGetAsync(
            'SELECT email_verified, two_factor_enabled, two_factor_secret FROM users WHERE LOWER(email) = LOWER(?)',
            [normalizedEmail]
        );
        if (!user || Number(user.email_verified ?? 1) !== 1) {
            return res.json({ success: true, twoFactorRequired: false });
        }
        const twoFactorRequired = Number(user.two_factor_enabled || 0) === 1 && !!normalizeTotpSecret(user.two_factor_secret);
        return res.json({ success: true, twoFactorRequired });
    } catch (error) {
        console.error(' 登录预检失败:', error);
        return res.json({ success: true, twoFactorRequired: false });
    }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
    try {
        const { email, password, fingerprint, twoFactorCode } = req.body;
        const normalizedEmail = normalizeEmailForAuth(email);

        if (!normalizedEmail || !password) {
            return res.status(400).json({ success: false, error: '邮箱和密码不能为空' });
        }

        if (!isValidEmailForAuth(normalizedEmail) || validatePasswordLength(password)) {
            return res.status(401).json({ success: false, error: '邮箱或密码错误' });
        }

        const user = await dbGetAsync('SELECT * FROM users WHERE LOWER(email) = LOWER(?)', [normalizedEmail]);
        if (!user) {
            return res.status(401).json({ success: false, error: '邮箱或密码错误' });
        }

        const validPassword = await bcrypt.compare(password, user.password_hash);
        if (!validPassword) {
            return res.status(401).json({ success: false, error: '邮箱或密码错误' });
        }

	        if (Number(user.email_verified ?? 1) !== 1) {
	            const sent = await sendEmailCodeOrReport({
	                email: normalizedEmail,
	                userId: user.id,
                purpose: 'register',
                metadata: { referrerId: user.pending_referrer_id || '' },
	                req
	            });
	            if (!sent.ok) {
	                if (shouldBypassResendTestingRestriction(sent.error)) {
	                    const payload = await completeRegistrationEmailVerification({
	                        user,
	                        req,
	                        fingerprint,
	                        referrerId: user.pending_referrer_id || '',
	                        bypassReason: 'resend_testing_domain_restricted'
                    });
	                    return res.json(payload);
	                }
	                if (isResendTestingRestrictionError(sent.error)) {
	                    return res.status(400).json({
	                        success: false,
	                        error: '验证邮件发送失败：邮件服务尚未完成发信域名验证，请联系管理员处理'
                    });
	                }
	                return res.status(502).json({ success: false, error: '验证邮件发送失败，请稍后再试' });
	            }
            return res.json({
                success: true,
                requiresEmailVerification: true,
                email: normalizedEmail,
                message: '请先验证注册邮箱'
            });
        }

        const twoFactorEnabled = Number(user.two_factor_enabled || 0) === 1 && !!normalizeTotpSecret(user.two_factor_secret);
        if (twoFactorEnabled) {
            const inlineTwoFactorCode = typeof twoFactorCode === 'string' ? twoFactorCode.trim() : '';
            if (inlineTwoFactorCode) {
                if (!verifyTotpCode(user.two_factor_secret, inlineTwoFactorCode)) {
                    return res.status(401).json({ success: false, error: 'Authenticator 验证码无效' });
                }
                const payload = await buildAuthenticatedUserPayload(user, req, fingerprint);
                console.log(' 登录成功(含二步验证), 用户ID:', user.id);
                return res.json(payload);
            }
            console.log(' 登录需要二步验证, 用户ID:', user.id);
            return res.json({
                success: false,
                requiresTwoFactor: true,
                twoFactorToken: buildUserLoginTwoFactorToken(user),
                message: '请输入 Authenticator 验证码'
            });
        }

        const payload = await buildAuthenticatedUserPayload(user, req, fingerprint);
        console.log(' 登录成功, 用户ID:', user.id);
        return res.json(payload);
    } catch (error) {
        console.error(' 登录错误:', error);
        res.status(500).json({ success: false, error: '服务器错误' });
    }
});

app.post('/api/auth/login/email-code/request', authLimiter, emailAuthLimiter, async (req, res) => {
    try {
        const normalizedEmail = normalizeEmailForAuth(req.body?.email);
        if (!isValidEmailForAuth(normalizedEmail)) {
            return res.status(400).json({ success: false, error: '邮件格式不正确' });
        }

        const user = await dbGetAsync('SELECT id, email, email_verified, pending_referrer_id FROM users WHERE LOWER(email) = LOWER(?)', [normalizedEmail]);
        if (!user) {
            return res.json({ success: true, message: '如果邮箱存在，验证码会发送到该邮箱' });
        }

        if (Number(user.email_verified ?? 1) !== 1) {
            const sent = await sendEmailCodeOrReport({
                email: normalizedEmail,
                userId: user.id,
                purpose: 'register',
                metadata: { referrerId: user.pending_referrer_id || '' },
                req
            });
            if (!sent.ok) {
                return res.status(502).json({ success: false, error: '验证邮件发送失败，请稍后再试' });
            }
            return res.json({ success: true, requiresEmailVerification: true, email: normalizedEmail, message: '请先验证注册邮箱' });
        }

        const sent = await sendEmailCodeOrReport({
            email: normalizedEmail,
            userId: user.id,
            purpose: 'login',
            req
        });
        if (!sent.ok) {
            return res.status(502).json({ success: false, error: '验证码邮件发送失败，请稍后再试' });
        }
        return res.json({ success: true, email: normalizedEmail, message: '验证码已发送到邮箱' });
    } catch (error) {
        console.error(' 登录邮箱验证码发送失败:', error);
        return res.status(500).json({ success: false, error: '服务器错误' });
    }
});

app.post('/api/auth/login/email-code/verify', authLimiter, async (req, res) => {
    try {
        const normalizedEmail = normalizeEmailForAuth(req.body?.email);
        const code = typeof req.body?.code === 'string' ? req.body.code : '';
        const fingerprint = typeof req.body?.fingerprint === 'string' ? req.body.fingerprint : '';

        if (!isValidEmailForAuth(normalizedEmail)) {
            return res.status(400).json({ success: false, error: '邮件格式不正确' });
        }

        const user = await dbGetAsync('SELECT * FROM users WHERE LOWER(email) = LOWER(?)', [normalizedEmail]);
        if (!user || Number(user.email_verified ?? 1) !== 1) {
            return res.status(401).json({ success: false, error: '验证码无效或已过期' });
        }

        const verification = await verifyAndConsumeEmailCode({
            email: normalizedEmail,
            purpose: 'login',
            code,
            userId: user.id
        });
        if (!verification.ok) {
            return res.status(400).json({ success: false, error: verification.error || '验证码无效或已过期' });
        }

        const twoFactorEnabled = Number(user.two_factor_enabled || 0) === 1 && !!normalizeTotpSecret(user.two_factor_secret);
        if (twoFactorEnabled) {
            return res.json({
                success: false,
                requiresTwoFactor: true,
                twoFactorToken: buildUserLoginTwoFactorToken(user),
                message: '请输入 Authenticator 验证码'
            });
        }

        const payload = await buildAuthenticatedUserPayload(user, req, fingerprint);
        console.log(' 邮箱验证码登录成功, 用户ID:', user.id);
        return res.json(payload);
    } catch (error) {
        console.error(' 邮箱验证码登录失败:', error);
        return res.status(500).json({ success: false, error: '服务器错误' });
    }
});

app.post('/api/auth/password/reset/request', authLimiter, emailAuthLimiter, async (req, res) => {
    try {
        const normalizedEmail = normalizeEmailForAuth(req.body?.email);
        if (!isValidEmailForAuth(normalizedEmail)) {
            return res.status(400).json({ success: false, error: '邮件格式不正确' });
        }

        const user = await dbGetAsync('SELECT id, email, email_verified FROM users WHERE LOWER(email) = LOWER(?)', [normalizedEmail]);
        if (!user || Number(user.email_verified ?? 1) !== 1) {
            return res.json({ success: true, message: '如果邮箱存在，验证码会发送到该邮箱' });
        }

        const sent = await sendEmailCodeOrReport({
            email: normalizedEmail,
            userId: user.id,
            purpose: 'password_reset',
            req
        });
        if (!sent.ok) {
            return res.status(502).json({ success: false, error: '验证码邮件发送失败，请稍后再试' });
        }
        return res.json({ success: true, email: normalizedEmail, message: '验证码已发送到邮箱' });
    } catch (error) {
        console.error(' 重置密码验证码发送失败:', error);
        return res.status(500).json({ success: false, error: '服务器错误' });
    }
});

app.post('/api/auth/password/reset/confirm', authLimiter, async (req, res) => {
    try {
        const normalizedEmail = normalizeEmailForAuth(req.body?.email);
        const code = typeof req.body?.code === 'string' ? req.body.code : '';
        const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
        const fingerprint = typeof req.body?.fingerprint === 'string' ? req.body.fingerprint : '';

        if (!isValidEmailForAuth(normalizedEmail)) {
            return res.status(400).json({ success: false, error: '邮件格式不正确' });
        }

        const newPasswordError = validatePasswordLength(newPassword, '新密码');
        if (newPasswordError) {
            return res.status(400).json({ success: false, error: newPasswordError });
        }

        const user = await dbGetAsync('SELECT * FROM users WHERE LOWER(email) = LOWER(?)', [normalizedEmail]);
        if (!user || Number(user.email_verified ?? 1) !== 1) {
            return res.status(400).json({ success: false, error: '验证码无效或已过期' });
        }

        const verification = await verifyAndConsumeEmailCode({
            email: normalizedEmail,
            purpose: 'password_reset',
            code,
            userId: user.id
        });
        if (!verification.ok) {
            return res.status(400).json({ success: false, error: verification.error || '验证码无效或已过期' });
        }

        const passwordHash = await bcrypt.hash(newPassword, 10);
        const updateResult = await dbRunAsync('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, user.id]);
        if (Number(updateResult?.changes || 0) !== 1) {
            throw new Error('password_reset_update_missing');
        }

        // 重置接口只有在数据库回读的新哈希确实能匹配新密码时才允许返回成功。
        // 这样不会出现前端提示“已重置”，实际登录却仍命中旧哈希的假成功。
        const updatedUser = await dbGetAsync('SELECT * FROM users WHERE id = ?', [user.id]);
        const persistedPasswordMatches = !!updatedUser
            && await bcrypt.compare(newPassword, updatedUser.password_hash).catch(() => false);
        if (!persistedPasswordMatches) {
            throw new Error('password_reset_post_write_verification_failed');
        }

        console.log(` 邮箱验证码重置密码成功: userId=${user.id}`);
        const twoFactorEnabled = Number(updatedUser.two_factor_enabled || 0) === 1
            && !!normalizeTotpSecret(updatedUser.two_factor_secret);
        if (twoFactorEnabled) {
            return res.json({
                success: true,
                passwordReset: true,
                requiresTwoFactor: true,
                twoFactorToken: buildUserLoginTwoFactorToken(updatedUser),
                message: '密码已重置，请输入 Authenticator 验证码完成登录'
            });
        }

        const payload = await buildAuthenticatedUserPayload(updatedUser, req, fingerprint);
        console.log(' 重置密码后直接登录, 用户ID:', updatedUser.id);
        return res.json({
            ...payload,
            passwordReset: true,
            message: '密码已重置并已登录'
        });
    } catch (error) {
        console.error(' 邮箱验证码重置密码失败:', error);
        return res.status(500).json({ success: false, error: '更新密码失败' });
    }
});

app.post('/api/auth/login/2fa', authLimiter, async (req, res) => {
    try {
        const twoFactorToken = typeof req.body?.twoFactorToken === 'string' ? req.body.twoFactorToken : '';
        const code = typeof req.body?.code === 'string' ? req.body.code : '';
        const fingerprint = typeof req.body?.fingerprint === 'string' ? req.body.fingerprint : '';

        if (!twoFactorToken || !code) {
            return res.status(400).json({ success: false, error: '二步验证码不能为空' });
        }

        let decoded;
        try {
            decoded = jwt.verify(twoFactorToken, JWT_SECRET);
        } catch (error) {
            return res.status(401).json({ success: false, error: '二步验证已过期，请重新登录' });
        }

        if (decoded?.type !== 'user_login_2fa' || !decoded.userId) {
            return res.status(401).json({ success: false, error: '二步验证无效，请重新登录' });
        }

        const user = await dbGetAsync('SELECT * FROM users WHERE id = ?', [decoded.userId]);
        if (!user || Number(user.two_factor_enabled || 0) !== 1 || !normalizeTotpSecret(user.two_factor_secret)) {
            return res.status(401).json({ success: false, error: '二步验证状态已变化，请重新登录' });
        }

        if (!verifyTotpCode(user.two_factor_secret, code)) {
            return res.status(401).json({ success: false, error: 'Authenticator 验证码无效' });
        }

        const payload = await buildAuthenticatedUserPayload(user, req, fingerprint);
        console.log(' 二步验证登录成功, 用户ID:', user.id);
        return res.json(payload);
    } catch (error) {
        console.error(' 二步验证登录失败:', error);
        res.status(500).json({ success: false, error: '二步验证失败' });
    }
});

app.get('/api/auth/verify', authenticateToken, (req, res) => {
    db.get(
        'SELECT id, email, username, avatar_url, external_provider, external_uid, COALESCE(email_verified, 1) as email_verified FROM users WHERE id = ?',
        [req.user.userId],
        (err, user) => {
            if (err || !user) {
                return res.status(404).json({ success: false, error: '用户不存在' });
            }
            res.json({ success: true, user });
        }
    );
});

// ==================== 用户管理路由 ====================
app.get('/api/user/profile', authenticateToken, (req, res) => {
    db.get(
        `SELECT u.id, u.email, u.username, u.avatar_url, u.created_at, u.last_login,
      COALESCE(u.email_verified, 1) as email_verified, u.email_verified_at,
	      u.pending_email, u.pending_email_expires_at, u.pending_email_current_verified_at, u.pending_email_code_hash,
      u.external_provider, u.external_uid, COALESCE(u.two_factor_enabled, 0) as two_factor_enabled,
      COALESCE(c.theme, 'dark') as theme,
      COALESCE(c.default_model, 'auto') as default_model,
      COALESCE(c.temperature, 0.7) as temperature,
      COALESCE(c.top_p, 0.9) as top_p,
      COALESCE(c.max_tokens, 2000) as max_tokens,
      COALESCE(c.frequency_penalty, 0) as frequency_penalty,
      COALESCE(c.presence_penalty, 0) as presence_penalty,
      COALESCE(c.system_prompt, '') as system_prompt,
      COALESCE(c.thinking_mode, 0) as thinking_mode,
	      1 as internet_mode,
 	      COALESCE(c.long_memory_enabled, ?) as long_memory_enabled,
          c.long_memory_opted_in_at as long_memory_opted_in_at,
          c.short_memory_titles as short_memory_titles,
          c.short_memory_updated_at as short_memory_updated_at,
          COALESCE(c.font_preference, 'rai') as font_preference,
          COALESCE(c.tab_title_mode, 'default') as tab_title_mode,
          c.tab_title_custom_text as tab_title_custom_text
    FROM users u
    LEFT JOIN user_configs c ON u.id = c.user_id
    WHERE u.id = ?`,
        [LONG_MEMORY_DEFAULT_ENABLED ? 1 : 0, req.user.userId],
        (err, user) => {
            if (err) {
                console.error(' 获取用户信息失败:', err);
                return res.status(500).json({ success: false, error: '获取用户资料失败' });
            }

            if (!user) {
                console.error(' 用户不存在, ID:', req.user.userId);
                return res.status(401).json({ success: false, error: '用户不存在，请重新登录' });
            }

            //  修复：确保所有字段都有值，特别是system_prompt
            const profile = {
                id: user.id,
                email: user.email || '',
                username: user.username || user.email.split('@')[0],
                avatar_url: user.avatar_url || null,
                email_verified: Number(user.email_verified ?? 1) === 1,
	                email_verified_at: user.email_verified_at || null,
	                pending_email: user.pending_email || null,
	                pending_email_expires_at: user.pending_email_expires_at || null,
	                pending_email_stage: user.pending_email
	                    ? (user.pending_email_current_verified_at && user.pending_email_code_hash ? 'new' : 'current')
	                    : null,
                external_provider: user.external_provider || null,
                external_uid: user.external_uid || null,
                two_factor_enabled: Number(user.two_factor_enabled || 0) === 1,
                created_at: user.created_at,
                last_login: user.last_login,
                theme: user.theme || 'dark',
                default_model: user.default_model || 'auto',
                temperature: parseFloat(user.temperature) || 0.7,
                top_p: parseFloat(user.top_p) || 0.9,
                max_tokens: parseInt(user.max_tokens, 10) || 2000,
                frequency_penalty: parseFloat(user.frequency_penalty) || 0,
                presence_penalty: parseFloat(user.presence_penalty) || 0,
                system_prompt: user.system_prompt || '',  //  关键修复：确保始终返回字符串
                thinking_mode: user.thinking_mode || 0,
	                internet_mode: 1,
	                long_memory_enabled: isMemoryOptedInConfig(user) ? 1 : 0,
                    long_memory_opted_in_at: user.long_memory_opted_in_at || null,
                    short_memory_titles: parseShortMemoryTitles(user.short_memory_titles),
                    font_preference: user.font_preference || 'rai',
                    tab_title_mode: user.tab_title_mode || 'default',
                    tab_title_custom_text: user.tab_title_custom_text || ''
            };

            console.log(' 返回用户信息, ID:', user.id, 'Username:', profile.username, 'SystemPromptLen:', profile.system_prompt.length);
            res.json(profile);
        }
    );
});

app.put('/api/user/profile', authenticateToken, async (req, res) => {
    try {
        const rawEmail = normalizeEmailForAuth(req.body?.email);
        const rawUsername = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
        const currentPassword = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
        const twoFactorCode = typeof req.body?.twoFactorCode === 'string' ? req.body.twoFactorCode : '';

        if (!rawEmail) {
            return res.status(400).json({ success: false, error: '邮箱不能为空' });
        }

        if (!isValidEmailForAuth(rawEmail)) {
            return res.status(400).json({ success: false, error: '邮件格式不正确' });
        }

        const usernameResult = normalizeUsernameForStorage(rawUsername);
        if (usernameResult.error) {
            return res.status(400).json({ success: false, error: usernameResult.error });
        }

        const existingUser = await dbGetAsync(
            `SELECT id, email, username, password_hash, avatar_url, external_provider, external_uid,
                    COALESCE(two_factor_enabled, 0) as two_factor_enabled, two_factor_secret
             FROM users
             WHERE id = ?`,
            [req.user.userId]
        );

        if (!existingUser) {
            return res.status(404).json({ success: false, error: '用户不存在' });
        }

        const currentEmail = normalizeEmailForAuth(existingUser.email);
        const emailChanged = rawEmail !== currentEmail;
        const finalUsername = usernameResult.value || buildDefaultUsernameFromEmail(emailChanged ? rawEmail : existingUser.email);

        if (emailChanged) {
            const duplicateUser = await dbGetAsync(
                'SELECT id FROM users WHERE LOWER(email) = LOWER(?) AND id != ?',
                [rawEmail, req.user.userId]
            );

            if (duplicateUser) {
                return res.status(409).json({ success: false, error: '该邮箱已被其他账号使用' });
            }

            const currentPasswordError = validatePasswordLength(currentPassword, '当前密码');
            if (currentPasswordError) {
                return res.status(400).json({ success: false, error: '修改邮箱需要输入当前密码' });
            }

            const passwordMatched = await bcrypt.compare(currentPassword, existingUser.password_hash).catch(() => false);
            if (!passwordMatched) {
                return res.status(400).json({ success: false, error: '当前密码错误' });
            }

            const twoFactorEnabled = Number(existingUser.two_factor_enabled || 0) === 1 && !!normalizeTotpSecret(existingUser.two_factor_secret);
            if (twoFactorEnabled && !verifyTotpCode(existingUser.two_factor_secret, twoFactorCode)) {
                return res.status(400).json({ success: false, error: 'Authenticator 验证码无效' });
            }

            await dbRunAsync('UPDATE users SET username = ? WHERE id = ?', [finalUsername, req.user.userId]);

            let pending;
            try {
                pending = await issuePendingEmailChangeCode({
                    userId: req.user.userId,
                    currentEmail,
                    email: rawEmail,
                    req
                });
            } catch (emailError) {
                console.error(' 修改邮箱验证码发送失败:', emailError);
                return res.status(503).json({
                    success: false,
                    error: '验证码发送失败，邮箱尚未变更，请稍后重试'
                });
            }

            const updatedUser = await dbGetAsync(
                'SELECT id, email, username, avatar_url, external_provider, external_uid FROM users WHERE id = ?',
                [req.user.userId]
            );

            console.log(` 用户邮箱变更待验证: userId=${existingUser.id}, old=${existingUser.email}, pending=${rawEmail}`);
            return res.json({
	                success: true,
	                email_change_verification_required: true,
	                current_email_verification_required: true,
	                pending_email: pending.pending_email,
	                pending_email_expires_at: pending.pending_email_expires_at,
	                pending_email_stage: pending.pending_email_stage,
	                user: {
                    id: updatedUser.id,
                    email: updatedUser.email,
                    username: updatedUser.username,
                    avatar_url: updatedUser.avatar_url || null,
                    external_provider: updatedUser.external_provider || null,
                    external_uid: updatedUser.external_uid || null
                }
            });
        }

        await dbRunAsync(
            'UPDATE users SET username = ? WHERE id = ?',
            [finalUsername, req.user.userId]
        );

        const updatedUser = await dbGetAsync(
            'SELECT id, email, username, avatar_url, external_provider, external_uid FROM users WHERE id = ?',
            [req.user.userId]
        );

        const refreshedToken = signUserSessionToken(updatedUser, JWT_SECRET);

        console.log(` 用户资料已更新: userId=${updatedUser.id}, email=${updatedUser.email}, username=${updatedUser.username}`);
        res.json({
            success: true,
            token: refreshedToken,
            user: {
                id: updatedUser.id,
                email: updatedUser.email,
                username: updatedUser.username,
                avatar_url: updatedUser.avatar_url || null,
                external_provider: updatedUser.external_provider || null,
                external_uid: updatedUser.external_uid || null
            }
        });
    } catch (error) {
        console.error(' 更新用户资料失败:', error);
        res.status(500).json({ success: false, error: '更新用户资料失败' });
    }
});

app.post('/api/user/profile/email/verify', authenticateToken, async (req, res) => {
    try {
        const email = normalizeEmailForAuth(req.body?.email);
        const code = normalizeEmailCodeInput(req.body?.code);
        const updatedUser = await verifyPendingEmailChange({
            userId: req.user.userId,
            email,
            code
        });

        const refreshedToken = signUserSessionToken(updatedUser, JWT_SECRET);

        console.log(` 用户邮箱变更已确认: userId=${updatedUser.id}, email=${updatedUser.email}`);
        res.json({
            success: true,
            token: refreshedToken,
            user: {
                id: updatedUser.id,
                email: updatedUser.email,
                username: updatedUser.username,
                avatar_url: updatedUser.avatar_url || null,
                external_provider: updatedUser.external_provider || null,
                external_uid: updatedUser.external_uid || null
            }
        });
    } catch (error) {
        console.error(' 确认邮箱变更失败:', error.message);
        res.status(error.statusCode || 500).json({
            success: false,
            error: error.statusCode ? error.message : '确认邮箱变更失败'
        });
    }
});

app.post('/api/user/profile/email/verify-current', authenticateToken, async (req, res) => {
    try {
        const email = normalizeEmailForAuth(req.body?.email);
        const currentEmailCode = normalizeEmailCodeInput(req.body?.currentEmailCode);
        const pending = await verifyPendingEmailCurrentCodeAndIssueNewCode({
            userId: req.user.userId,
            email,
            currentEmailCode,
            req
        });

        res.json({
            success: true,
            new_email_verification_required: true,
            pending_email: pending.pending_email,
            pending_email_expires_at: pending.pending_email_expires_at,
            pending_email_stage: pending.pending_email_stage
        });
    } catch (error) {
        console.error(' 确认旧邮箱验证码失败:', error.message);
        res.status(error.statusCode || 500).json({
            success: false,
            error: error.statusCode ? error.message : '确认旧邮箱验证码失败'
        });
    }
});

app.post('/api/user/2fa/setup', authenticateToken, async (req, res) => {
    try {
        const user = await dbGetAsync(
            'SELECT id, email, username, two_factor_enabled FROM users WHERE id = ?',
            [req.user.userId]
        );

        if (!user) {
            return res.status(404).json({ success: false, error: '用户不存在' });
        }

        if (Number(user.two_factor_enabled || 0) === 1) {
            return res.status(409).json({ success: false, error: '二步验证已开启' });
        }

        const secret = generateTotpSecret();
        const setupChallenge = await createUserTwoFactorSetupChallenge(user, secret);
        const accountName = user.email || `user-${user.id}`;
        const otpauthUrl = buildOtpAuthUrl({ accountName, secret });
        const qrDataUrl = await QRCode.toDataURL(otpauthUrl, {
            errorCorrectionLevel: 'M',
            margin: 1,
            width: 192
        });

        res.json({
            success: true,
            secret,
            otpauthUrl,
            qrDataUrl,
            setupToken: buildUserTwoFactorSetupToken(user, setupChallenge.setupId),
            expiresAt: setupChallenge.expiresAt
        });
    } catch (error) {
        console.error(' 创建二步验证设置失败:', error);
        res.status(500).json({ success: false, error: '创建二步验证失败' });
    }
});

app.post('/api/user/2fa/enable', authenticateToken, async (req, res) => {
    try {
        const setupToken = typeof req.body?.setupToken === 'string' ? req.body.setupToken : '';
        const code = typeof req.body?.code === 'string' ? req.body.code : '';

        if (!setupToken || !code) {
            return res.status(400).json({ success: false, error: '二步验证码不能为空' });
        }

        let decoded;
        try {
            decoded = jwt.verify(setupToken, JWT_SECRET);
        } catch (error) {
            return res.status(401).json({ success: false, error: '二步验证设置已过期，请重新生成' });
        }

        if (
            decoded?.type !== 'user_2fa_setup'
            || Number(decoded.userId) !== Number(req.user.userId)
            || !decoded.setupId
        ) {
            return res.status(401).json({ success: false, error: '二步验证设置无效，请重新生成' });
        }

        const setupChallenge = await consumeUserTwoFactorSetupChallenge({
            setupId: decoded.setupId,
            userId: req.user.userId
        });
        const secret = normalizeTotpSecret(setupChallenge?.secret);
        if (!secret) {
            return res.status(401).json({ success: false, error: '二步验证设置已过期，请重新生成' });
        }

        if (!verifyTotpCode(secret, code)) {
            return res.status(400).json({ success: false, error: 'Authenticator 验证码无效' });
        }

        await dbRunAsync(
            `UPDATE users
             SET two_factor_enabled = 1,
                 two_factor_secret = ?,
                 two_factor_confirmed_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [secret, req.user.userId]
        );

        console.log(` 用户二步验证已开启: userId=${req.user.userId}`);
        res.json({ success: true, two_factor_enabled: true });
    } catch (error) {
        console.error(' 开启二步验证失败:', error);
        res.status(500).json({ success: false, error: '开启二步验证失败' });
    }
});

app.post('/api/user/2fa/disable', authenticateToken, async (req, res) => {
    try {
        const code = typeof req.body?.code === 'string' ? req.body.code : '';
        if (!code) {
            return res.status(400).json({ success: false, error: '二步验证码不能为空' });
        }

        const user = await dbGetAsync(
            'SELECT id, two_factor_enabled, two_factor_secret FROM users WHERE id = ?',
            [req.user.userId]
        );

        if (!user) {
            return res.status(404).json({ success: false, error: '用户不存在' });
        }

        if (Number(user.two_factor_enabled || 0) !== 1 || !normalizeTotpSecret(user.two_factor_secret)) {
            return res.status(409).json({ success: false, error: '二步验证尚未开启' });
        }

        if (!verifyTotpCode(user.two_factor_secret, code)) {
            return res.status(400).json({ success: false, error: 'Authenticator 验证码无效' });
        }

        await dbRunAsync(
            `UPDATE users
             SET two_factor_enabled = 0,
                 two_factor_secret = NULL,
                 two_factor_confirmed_at = NULL
             WHERE id = ?`,
            [req.user.userId]
        );

        console.log(` 用户二步验证已关闭: userId=${req.user.userId}`);
        res.json({ success: true, two_factor_enabled: false });
    } catch (error) {
        console.error(' 关闭二步验证失败:', error);
        res.status(500).json({ success: false, error: '关闭二步验证失败' });
    }
});

app.put('/api/user/password', authenticateToken, async (req, res) => {
    try {
        const currentPassword = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
        const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';

        if (!currentPassword) {
            return res.status(400).json({ success: false, error: '当前密码不能为空' });
        }

        const currentPasswordError = validatePasswordLength(currentPassword, '当前密码');
        const newPasswordError = validatePasswordLength(newPassword, '新密码');

        if (currentPasswordError) {
            return res.status(400).json({ success: false, error: currentPasswordError });
        }

        if (newPasswordError) {
            return res.status(400).json({ success: false, error: newPasswordError });
        }

        if (newPassword === currentPassword) {
            return res.status(400).json({ success: false, error: '新密码不能与当前密码相同' });
        }

        const user = await dbGetAsync(
            'SELECT id, email, password_hash FROM users WHERE id = ?',
            [req.user.userId]
        );

        if (!user) {
            return res.status(404).json({ success: false, error: '用户不存在' });
        }

        const passwordMatched = await bcrypt.compare(currentPassword, user.password_hash);
        if (!passwordMatched) {
            return res.status(400).json({ success: false, error: '当前密码错误' });
        }

        const nextPasswordHash = await bcrypt.hash(newPassword, 10);
        await dbRunAsync(
            'UPDATE users SET password_hash = ? WHERE id = ?',
            [nextPasswordHash, user.id]
        );

        console.log(` 用户密码已更新: userId=${user.id}, email=${user.email}`);
        res.json({ success: true });
    } catch (error) {
        console.error(' 更新用户密码失败:', error);
        res.status(500).json({ success: false, error: '更新密码失败' });
    }
});

app.delete('/api/user/account', authenticateToken, async (req, res) => {
    try {
        const currentPassword = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
        const confirmation = String(req.body?.confirmation || '').normalize('NFKC').trim();
        const twoFactorCode = typeof req.body?.twoFactorCode === 'string' ? req.body.twoFactorCode : '';

        if (!currentPassword) {
            return res.status(400).json({ success: false, error: '当前密码不能为空' });
        }

        if (!ACCOUNT_DELETE_CONFIRMATIONS.has(confirmation)) {
            return res.status(400).json({ success: false, error: '确认词不正确' });
        }

        const user = await dbGetAsync(
            'SELECT id, email, password_hash, two_factor_enabled, two_factor_secret FROM users WHERE id = ?',
            [req.user.userId]
        );

        if (!user) {
            return res.status(404).json({ success: false, error: '用户不存在' });
        }

        const passwordMatched = await bcrypt.compare(currentPassword, user.password_hash).catch(() => false);
        if (!passwordMatched) {
            return res.status(400).json({ success: false, error: '当前密码错误' });
        }

        const twoFactorEnabled = Number(user.two_factor_enabled || 0) === 1 && !!normalizeTotpSecret(user.two_factor_secret);
        if (twoFactorEnabled && !verifyTotpCode(user.two_factor_secret, twoFactorCode)) {
            return res.status(400).json({ success: false, error: 'Authenticator 验证码无效' });
        }

        const result = await deleteUserDataCascade(user.id, { actor: 'self' });
        if (!result.success) {
            return res.status(404).json({ success: false, error: '用户不存在' });
        }

        console.log(` 用户自助注销完成: userId=${user.id}, email=${user.email}, uploads=${result.deletedUploads}, files=${result.deletedFiles}`);
        return res.json({
            success: true,
            deletedUserId: result.deletedUserId,
            deletedUploads: result.deletedUploads,
            deletedFiles: result.deletedFiles
        });
    } catch (error) {
        console.error(' 用户自助注销失败:', error);
        return res.status(error.statusCode || 500).json({ success: false, error: '注销账号失败' });
    }
});

function clampNumber(value, min, max, fallback) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.min(Math.max(numeric, min), max);
}

function clampInteger(value, min, max, fallback) {
    return Math.round(clampNumber(value, min, max, fallback));
}

function sanitizeUserConfigPayload(payload = {}) {
    const theme = ['light', 'dark', 'system'].includes(String(payload.theme || '').trim())
        ? String(payload.theme).trim()
        : 'dark';
    const defaultModel = normalizeIncomingModelId(payload.default_model || 'auto');
    const safeDefaultModel = defaultModel === 'auto' || PUBLIC_MODEL_IDS.includes(defaultModel) || MODEL_ROUTING[defaultModel]
        ? defaultModel
        : 'auto';
    const fontPreference = String(payload.font_preference || '').trim().toLowerCase() === 'system' ? 'system' : 'rai';
    const allowedTabTitleModes = ['default', 'static', 'marquee', 'greeting', 'title', 'custom'];
    const tabTitleMode = allowedTabTitleModes.includes(String(payload.tab_title_mode || '').trim())
        ? String(payload.tab_title_mode).trim()
        : 'default';
    const tabTitleCustomText = String(payload.tab_title_custom_text ?? '').slice(0, 80);

    return {
        theme,
        default_model: safeDefaultModel,
        temperature: clampNumber(payload.temperature, 0, 2, 0.7),
        top_p: clampNumber(payload.top_p, 0, 1, 0.9),
        max_tokens: clampInteger(payload.max_tokens, 256, 128000, 2000),
        frequency_penalty: clampNumber(payload.frequency_penalty, -2, 2, 0),
        presence_penalty: clampNumber(payload.presence_penalty, -2, 2, 0),
        system_prompt: String(payload.system_prompt ?? '').slice(0, 12000),
        thinking_mode: payload.thinking_mode ? 1 : 0,
        // Internet search is opt-out for the current chat only; it never persists as disabled.
        internet_mode: 1,
        long_memory_enabled: payload.long_memory_enabled === undefined
            ? null
            : (isLongMemoryEnabledValue(payload.long_memory_enabled) ? 1 : 0),
        font_preference: fontPreference,
        tab_title_mode: tabTitleMode,
        tab_title_custom_text: tabTitleCustomText
    };
}

app.put('/api/user/config', authenticateToken, async (req, res) => {
    const safeConfig = sanitizeUserConfigPayload(req.body);

    try {
        await dbRunAsync(
            `INSERT INTO user_configs (
          user_id, theme, default_model, temperature, top_p, max_tokens,
          frequency_penalty, presence_penalty, system_prompt, thinking_mode, internet_mode, long_memory_enabled,
          font_preference, tab_title_mode, tab_title_custom_text
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, 0), ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          theme = excluded.theme,
          default_model = excluded.default_model,
          temperature = excluded.temperature,
          top_p = excluded.top_p,
          max_tokens = excluded.max_tokens,
          frequency_penalty = excluded.frequency_penalty,
          presence_penalty = excluded.presence_penalty,
          system_prompt = excluded.system_prompt,
          thinking_mode = excluded.thinking_mode,
          internet_mode = excluded.internet_mode,
          long_memory_enabled = CASE
            WHEN ? IS NULL THEN user_configs.long_memory_enabled
            ELSE excluded.long_memory_enabled
          END,
          font_preference = excluded.font_preference,
          tab_title_mode = excluded.tab_title_mode,
          tab_title_custom_text = excluded.tab_title_custom_text`,
            [
                req.user.userId, safeConfig.theme, safeConfig.default_model,
                safeConfig.temperature, safeConfig.top_p, safeConfig.max_tokens,
                safeConfig.frequency_penalty, safeConfig.presence_penalty, safeConfig.system_prompt,
                safeConfig.thinking_mode, safeConfig.internet_mode, safeConfig.long_memory_enabled,
                safeConfig.font_preference, safeConfig.tab_title_mode, safeConfig.tab_title_custom_text,
                safeConfig.long_memory_enabled
            ]
        );

        let memory = null;
        if (safeConfig.long_memory_enabled !== null) {
            memory = await setUserLongMemoryEnabled(req.user.userId, safeConfig.long_memory_enabled === 1);
        }

        console.log(` 用户配置已保存: userId=${req.user.userId}, systemPromptLength=${safeConfig.system_prompt.length}, longMemory=${memory ? memory.enabled : 'unchanged'}`);
        res.json({ success: true, memory });
    } catch (err) {
        console.error(' 保存配置失败:', err);
        res.status(500).json({ error: '保存失败' });
    }
});

app.get('/api/user/memories', authenticateToken, async (req, res) => {
    try {
        const enabled = await isUserLongMemoryEnabled(req.user.userId);
        const memories = enabled ? await listActiveUserMemories(req.user.userId, 200) : [];
        const shortTermMemory = enabled
            ? await refreshUserShortTermMemorySnapshot(req.user.userId)
            : [];
        res.json({ success: true, enabled, memories, shortTermMemory });
    } catch (error) {
        console.error(' 获取用户记忆失败:', error);
        res.status(500).json({ success: false, error: '获取记忆失败' });
    }
});

app.post('/api/user/memories', authenticateToken, async (req, res) => {
    try {
        if (!await isUserLongMemoryEnabled(req.user.userId)) {
            return res.status(400).json({ success: false, error: '请先开启记忆' });
        }
        const content = sanitizeMemoryContent(req.body?.content);
        const category = normalizeMemoryCategory(req.body?.category);
        if (!content || content.length < 2) {
            return res.status(400).json({ success: false, error: '记忆内容不能为空' });
        }
        await upsertUserMemory({
            userId: req.user.userId,
            category,
            content,
            confidence: 1
        });
        const memories = await listActiveUserMemories(req.user.userId, 200);
        res.json({ success: true, memories });
    } catch (error) {
        console.error(' 新增用户记忆失败:', error);
        res.status(500).json({ success: false, error: '保存记忆失败' });
    }
});

app.post('/api/user/memories/clear', authenticateToken, async (req, res) => {
    try {
        await dbRunAsync(
            `UPDATE user_memories
             SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE user_id = ? AND deleted_at IS NULL`,
            [req.user.userId]
        );
        res.json({ success: true, memories: [] });
    } catch (error) {
        console.error(' 清空用户记忆失败:', error);
        res.status(500).json({ success: false, error: '清空记忆失败' });
    }
});

app.patch('/api/user/memories/:id', authenticateToken, async (req, res) => {
    try {
        const memoryId = Number(req.params.id);
        if (!Number.isInteger(memoryId) || memoryId <= 0) {
            return res.status(400).json({ success: false, error: '记忆 ID 无效' });
        }
        if (req.body?.deleted === true || req.body?.deleted === 1 || req.body?.deleted === '1') {
            await softDeleteUserMemory(req.user.userId, memoryId);
        } else {
            const content = sanitizeMemoryContent(req.body?.content);
            const category = normalizeMemoryCategory(req.body?.category);
            if (!content || content.length < 2) {
                return res.status(400).json({ success: false, error: '记忆内容不能为空' });
            }
            const memoryKey = buildMemoryKey(category, content);
            await dbRunAsync(
                `UPDATE user_memories
                 SET memory_key = ?, category = ?, content = ?, confidence = 1, updated_at = CURRENT_TIMESTAMP, deleted_at = NULL
                 WHERE id = ? AND user_id = ?`,
                [memoryKey, category, content, memoryId, req.user.userId]
            );
        }
        const memories = await listActiveUserMemories(req.user.userId, 200);
        res.json({ success: true, memories });
    } catch (error) {
        console.error(' 更新用户记忆失败:', error);
        res.status(500).json({ success: false, error: '更新记忆失败' });
    }
});

app.delete('/api/user/memories/:id', authenticateToken, async (req, res) => {
    try {
        const memoryId = Number(req.params.id);
        if (!Number.isInteger(memoryId) || memoryId <= 0) {
            return res.status(400).json({ success: false, error: '记忆 ID 无效' });
        }
        await softDeleteUserMemory(req.user.userId, memoryId);
        const memories = await listActiveUserMemories(req.user.userId, 200);
        res.json({ success: true, memories });
    } catch (error) {
        console.error(' 删除用户记忆失败:', error);
        res.status(500).json({ success: false, error: '删除记忆失败' });
    }
});

app.post('/api/user/avatar', authenticateToken, (req, res, next) => runUpload(avatarUpload.single('avatar'), req, res, next), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: '没有文件上传' });

    try {
        await validateUploadedFileContent(req.file, 'avatar');
    } catch (error) {
        fs.unlink(req.file.path, () => null);
        return res.status(error.statusCode || 400).json({ error: error.message || '头像上传失败' });
    }

    const avatarUrl = `/avatars/${req.file.filename}`;
    db.run('UPDATE users SET avatar_url = ? WHERE id = ?', [avatarUrl, req.user.userId], (err) => {
        if (err) {
            console.error(' 更新头像失败:', err);
            return res.status(500).json({ error: '更新失败' });
        }
        res.json({ success: true, avatar_url: avatarUrl });
    });
});

// ==================== 会话管理路由 ====================
app.get('/api/sessions', authenticateToken, async (req, res) => {
    try {
        await ensureSessionKindColumn();

        // 分页参数：offset（偏移量）和 limit（每页数量）
        const offset = parseBoundedInteger(req.query.offset, 0, 0, 100000);
        const limit = parseBoundedInteger(req.query.limit, 20, 1, 100);

        // 优化：简化查询，移除慢速子查询（message_count, recent_attachments）
        // 只保留 last_message 用于侧边栏预览
        db.all(
            `SELECT s.id, s.title, s.model, s.session_kind, s.updated_at, s.created_at,
          (SELECT content FROM messages WHERE session_id = s.id ORDER BY created_at DESC, id DESC LIMIT 1) as last_message,
          (SELECT content FROM messages WHERE session_id = s.id AND role = 'assistant' ORDER BY created_at DESC, id DESC LIMIT 1) as last_assistant_message
        FROM sessions s
        WHERE s.user_id = ? AND s.is_archived = 0 AND COALESCE(s.session_kind, 'chat') IN ('chat', 'temporary_saved')
        ORDER BY s.updated_at DESC
        LIMIT ? OFFSET ?`,
            [req.user.userId, limit, offset],
            (err, sessions) => {
                if (err) {
                    console.error(' 获取会话列表失败:', err);
                    return res.status(500).json({ error: '数据库错误' });
                }
                // 返回带有分页信息的响应
                res.json({
                    sessions: sessions,
                    hasMore: sessions.length === limit,
                    offset: offset,
                    limit: limit
                });
            }
        );
    } catch (error) {
        console.error(' 确保sessions表结构失败:', error);
        res.status(500).json({ error: '数据库结构初始化失败' });
    }
});

app.post('/api/sessions', authenticateToken, async (req, res) => {
    try {
        await ensureSessionKindColumn();

        const sessionId = `session_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        const { title, model, session_kind: sessionKind = 'chat' } = req.body;
        const requestedTitle = String(title || '').trim();
        const fallbackTitle = String(sessionKind || 'chat') === 'temporary_saved' ? '临时对话' : '新对话';
        const safeTitle = sanitizeGeneratedConversationTitle(requestedTitle)
            || (requestedTitle && GENERIC_SESSION_TITLE_RE.test(requestedTitle) ? requestedTitle : fallbackTitle);

        db.run(
            'INSERT INTO sessions (id, user_id, title, model, session_kind) VALUES (?, ?, ?, ?, ?)',
            [sessionId, req.user.userId, safeTitle, model || 'deepseek-pro', sessionKind || 'chat'],
            (err) => {
                if (err) {
                    console.error(' 创建会话失败:', err);
                    return res.status(500).json({ error: '创建失败' });
                }
                console.log(' 创建会话成功:', sessionId);
                res.json({ success: true, sessionId });
            }
        );
    } catch (error) {
        console.error(' 确保sessions表结构失败:', error);
        res.status(500).json({ error: '数据库结构初始化失败' });
    }
});

app.put('/api/sessions/:id', authenticateToken, (req, res) => {
    const { title, model, is_archived } = req.body;
    const safeTitle = title === undefined ? null : sanitizeGeneratedConversationTitle(title);

    db.run(
        'UPDATE sessions SET title = COALESCE(?, title), model = COALESCE(?, model), is_archived = COALESCE(?, is_archived), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?',
        [safeTitle, model, is_archived, req.params.id, req.user.userId],
        (err) => {
            if (err) {
                console.error(' 更新会话失败:', err);
                return res.status(500).json({ error: '更新失败' });
            }
            res.json({ success: true });
        }
    );
});

app.delete('/api/sessions/:id', authenticateToken, (req, res) => {
    db.run('DELETE FROM sessions WHERE id = ? AND user_id = ?', [req.params.id, req.user.userId], (err) => {
        if (err) {
            console.error(' 删除会话失败:', err);
            return res.status(500).json({ error: '删除失败' });
        }
        console.log(' 删除会话成功:', req.params.id);
        res.json({ success: true });
    });
});

app.get('/api/sessions/:id/messages', authenticateToken, (req, res) => {
    db.get('SELECT user_id FROM sessions WHERE id = ?', [req.params.id], (err, session) => {
        if (err) {
            console.error(' 查询会话失败:', err);
            return res.status(500).json({ error: '数据库错误' });
        }

        if (!session || session.user_id !== req.user.userId) {
            return res.status(403).json({ error: '无权访问此会话' });
        }

        // 优化：只查询必要字段，避免加载大的attachments Base64数据
        // 附件数据可以按需加载（懒加载）
        db.all(
            `SELECT id, session_id, role, content, reasoning_content, model, 
                    enable_search, thinking_mode, internet_mode, sources, process_trace, created_at,
                    CASE WHEN attachments IS NOT NULL AND attachments != '' AND attachments != '[]' 
                         THEN 1 ELSE 0 END as has_attachments
             FROM messages WHERE session_id = ? ORDER BY created_at ASC, id ASC`,
            [req.params.id],
            (err, messages) => {
                if (err) {
                    console.error(' 获取消息失败:', err);
                    return res.status(500).json({ error: '数据库错误' });
                }
                res.json(messages);
            }
        );
    });
});

app.get('/api/sessions/:id/stream-events', async (req, res) => {
    const bearerToken = getBearerToken(req);
    const rawToken = bearerToken || String(req.query.token || '').trim();
    if (!rawToken) {
        return res.status(401).json({ error: '未提供认证令牌' });
    }

    let user;
    try {
        user = verifyUserSessionToken(rawToken, JWT_SECRET);
    } catch (error) {
        return res.status(403).json({ error: '令牌无效或已过期' });
    }

    const sessionId = String(req.params.id || '').trim();
    try {
        const session = await dbGetAsync('SELECT user_id FROM sessions WHERE id = ?', [sessionId]);
        if (!session || session.user_id !== user.userId) {
            return res.status(403).json({ error: '无权访问此会话' });
        }
    } catch (error) {
        console.error(' 查询会话流权限失败:', error);
        return res.status(500).json({ error: '数据库错误' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-store, no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    sendSessionStreamEvent(res, { type: 'session_stream_ready', sessionId });
    getSessionStreamSubscribers(sessionId).add(res);

    const state = sessionStreamStates.get(sessionId);
    if (state && state.userId === user.userId && state.status === 'running') {
        sendSessionStreamEvent(res, {
            type: 'session_stream_snapshot',
            requestId: state.requestId,
            sessionId,
            userContent: state.userContent || '',
            content: state.assistantContent || '',
            reasoningContent: state.reasoningContent || '',
            model: state.model || '',
            status: state.status,
            updatedAt: new Date(state.updatedAt || Date.now()).toISOString()
        });
    }

    const keepAlive = setInterval(() => {
        sendSessionStreamEvent(res, { type: 'session_stream_ping', ts: Date.now() });
    }, 25000);

    req.on('close', () => {
        clearInterval(keepAlive);
        const activeState = sessionStreamStates.get(sessionId);
        if (activeState) {
            activeState.subscribers.delete(res);
        }
        const subscribers = sessionStreamSubscribers.get(sessionId);
        if (subscribers) {
            subscribers.delete(res);
            if (subscribers.size === 0) {
                sessionStreamSubscribers.delete(sessionId);
            }
        }
    });
});

// ==================== ChatFlow API ====================

const FLOW_DEFAULT_CANVAS_STATE = Object.freeze({
    nodes: [],
    edges: [],
    viewport: {
        x: 0,
        y: 0,
        zoom: 1
    }
});

const CANVAS_OPS_START_TOKEN = '[CANVAS_OPS]';
const CANVAS_OPS_END_TOKEN = '[/CANVAS_OPS]';
const TITLE_START_TOKEN = '[TITLE]';
const TITLE_END_TOKEN = '[/TITLE]';
const STRUCTURED_OUTPUT_TOKENS = [
    CANVAS_OPS_START_TOKEN,
    CANVAS_OPS_END_TOKEN,
    TITLE_START_TOKEN,
    TITLE_END_TOKEN
];

function cloneFlowDefaultCanvasState() {
    return JSON.parse(JSON.stringify(FLOW_DEFAULT_CANVAS_STATE));
}

function safeJsonParse(rawValue, fallbackValue) {
    if (rawValue === null || rawValue === undefined || rawValue === '') {
        return fallbackValue;
    }

    if (typeof rawValue === 'object') {
        return rawValue;
    }

    try {
        return JSON.parse(rawValue);
    } catch (error) {
        return fallbackValue;
    }
}

function normalizeFlowViewport(viewport = {}) {
    const x = Number(viewport?.x);
    const y = Number(viewport?.y);
    const zoom = Number(viewport?.zoom);
    return {
        x: Number.isFinite(x) ? x : 0,
        y: Number.isFinite(y) ? y : 0,
        zoom: Number.isFinite(zoom) && zoom > 0 ? zoom : 1
    };
}

function normalizeFlowCanvasNode(node = {}) {
    const normalizedNode = { ...node };

    if (normalizedNode.sourceMessageId !== undefined && normalizedNode.sourceMessageId !== null && normalizedNode.sourceMessageId !== '') {
        const numericMessageId = Number(normalizedNode.sourceMessageId);
        normalizedNode.sourceMessageId = Number.isFinite(numericMessageId) ? numericMessageId : normalizedNode.sourceMessageId;
    } else {
        delete normalizedNode.sourceMessageId;
    }

    if (normalizedNode.sourceIndex !== undefined && normalizedNode.sourceIndex !== null && normalizedNode.sourceIndex !== '') {
        const numericSourceIndex = Number(normalizedNode.sourceIndex);
        normalizedNode.sourceIndex = Number.isFinite(numericSourceIndex) ? numericSourceIndex : normalizedNode.sourceIndex;
    } else {
        delete normalizedNode.sourceIndex;
    }

    return normalizedNode;
}

function normalizeFlowCanvasState(rawCanvasState) {
    const parsedCanvasState = safeJsonParse(rawCanvasState, cloneFlowDefaultCanvasState()) || cloneFlowDefaultCanvasState();
    const viewport = normalizeFlowViewport(parsedCanvasState.viewport || parsedCanvasState.viewPort || {});
    const nodes = Array.isArray(parsedCanvasState.nodes)
        ? parsedCanvasState.nodes.map((node) => normalizeFlowCanvasNode(node)).filter(Boolean)
        : [];
    const edges = Array.isArray(parsedCanvasState.edges)
        ? parsedCanvasState.edges.map((edge) => ({ ...edge })).filter(Boolean)
        : [];

    return {
        nodes,
        edges,
        viewport
    };
}

function normalizeLegacyFlowMessages(rawChatHistory) {
    const parsedChatHistory = safeJsonParse(rawChatHistory, []);
    if (!Array.isArray(parsedChatHistory)) return [];

    return parsedChatHistory
        .filter((item) => item && (item.role === 'user' || item.role === 'assistant'))
        .map((item) => ({
            role: item.role,
            content: typeof item.content === 'string' ? item.content : String(item.content || '')
        }));
}

function trimStructuredTokenPrefix(text = '') {
    let result = String(text || '');
    for (const token of STRUCTURED_OUTPUT_TOKENS) {
        const maxPrefixLength = Math.min(token.length - 1, result.length);
        for (let len = maxPrefixLength; len > 0; len -= 1) {
            if (token.startsWith(result.slice(-len))) {
                result = result.slice(0, -len);
                break;
            }
        }
    }
    return result;
}

function parseCanvasPatchPayload(rawPatchText = '') {
    const raw = String(rawPatchText || '').trim();
    if (!raw) {
        return {
            canvasPatch: null,
            canvasPatchRaw: '',
            canvasPatchParseError: null
        };
    }

    try {
        return {
            canvasPatch: JSON.parse(raw),
            canvasPatchRaw: raw,
            canvasPatchParseError: null
        };
    } catch (error) {
        return {
            canvasPatch: null,
            canvasPatchRaw: raw,
            canvasPatchParseError: error.message
        };
    }
}

function extractLegacyTrailingTitle(text = '') {
    const source = String(text || '').trimEnd();
    const match = source.match(/<{2,3}\s*([^<>\n]{1,40}?)\s*>{2,3}\s*$/);
    if (!match) {
        return {
            title: null,
            cleanContent: source.trim()
        };
    }

    return {
        title: String(match[1] || '').replace(/\s+/g, ' ').trim() || null,
        cleanContent: source.replace(/<{2,3}\s*([^<>\n]{1,40}?)\s*>{2,3}\s*$/, '').trim()
    };
}

function parseStructuredAssistantOutput(rawText = '') {
    const source = String(rawText || '');
    let visibleContent = '';
    let extractedTitle = null;
    let canvasPatchRaw = '';
    let canvasPatch = null;
    let canvasPatchParseError = null;
    let cursor = 0;

    while (cursor < source.length) {
        if (source.startsWith(TITLE_START_TOKEN, cursor)) {
            const titleEnd = source.indexOf(TITLE_END_TOKEN, cursor + TITLE_START_TOKEN.length);
            if (titleEnd === -1) {
                break;
            }
            if (extractedTitle === null) {
                extractedTitle = source.slice(cursor + TITLE_START_TOKEN.length, titleEnd).trim();
            }
            cursor = titleEnd + TITLE_END_TOKEN.length;
            continue;
        }

        if (source.startsWith(CANVAS_OPS_START_TOKEN, cursor)) {
            const patchEnd = source.indexOf(CANVAS_OPS_END_TOKEN, cursor + CANVAS_OPS_START_TOKEN.length);
            if (patchEnd === -1) {
                break;
            }
            if (!canvasPatchRaw) {
                const parsedPatch = parseCanvasPatchPayload(source.slice(cursor + CANVAS_OPS_START_TOKEN.length, patchEnd));
                canvasPatchRaw = parsedPatch.canvasPatchRaw;
                canvasPatch = parsedPatch.canvasPatch;
                canvasPatchParseError = parsedPatch.canvasPatchParseError;
            }
            cursor = patchEnd + CANVAS_OPS_END_TOKEN.length;
            continue;
        }

        visibleContent += source[cursor];
        cursor += 1;
    }

    const legacyTitleResult = extractedTitle ? null : extractLegacyTrailingTitle(visibleContent);
    if (legacyTitleResult?.title) {
        extractedTitle = legacyTitleResult.title;
        visibleContent = legacyTitleResult.cleanContent;
    }

    return {
        visibleContent: trimStructuredTokenPrefix(visibleContent).trimEnd(),
        extractedTitle,
        canvasPatch,
        canvasPatchRaw,
        canvasPatchParseError
    };
}

function sanitizeGeneratedConversationTitle(text = '', uiLanguage = '') {
    let title = String(text || '')
        .replace(/\[TITLE\]|\[\/TITLE\]/gi, '')
        .replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, '')
        .trim();
    if (!title) return null;

    try {
        const parsed = JSON.parse(title);
        if (typeof parsed === 'string') {
            title = parsed;
        } else if (parsed && typeof parsed.title === 'string') {
            title = parsed.title;
        } else {
            return null;
        }
    } catch {
        // Model should return plain text; ignore JSON parse failures.
    }

    if (/^\s*[\[{]/.test(title) || /"id"\s*:/.test(title)) {
        return null;
    }

    title = String(title || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) || '';
    title = title
        .replace(/^(?:标题|对话标题|title|chat title|conversation title)\s*[:：-]\s*/i, '')
        .replace(/[\[\]<>]/g, '')
        .replace(/[。.!！?？,，;；:：]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    const maxChars = /zh|cn|hans|hant|中文|简|繁/i.test(String(uiLanguage || '')) ? 18 : 60;
    const chars = Array.from(title);
    if (chars.length > maxChars) {
        title = chars.slice(0, maxChars).join('').trim();
    }
    if (!title || GENERIC_SESSION_TITLE_RE.test(title)) return null;
    return title;
}

async function generateFallbackConversationTitleWithModel({ modelId, userContent = '', assistantContent = '', uiLanguage = '' } = {}) {
    if (!isRuntimeConfiguredModel(modelId)) {
        appendRaiRuntimeReport({
            level: '报错',
            tag: 'title_fallback_model_unavailable',
            message: 'Title fallback model is not configured',
            context: { modelId }
        });
        return null;
    }

    const routing = MODEL_ROUTING[modelId];
    const providerConfig = routing ? API_PROVIDERS[routing.provider] : null;
    if (!routing || !providerConfig?.apiKey || providerConfig.isGemini || routing.isGemini) return null;

    const system = [
        'You generate concise conversation titles for a chat app.',
        'Return the title text only.',
        'Use the same language as the latest user message.',
        'Chinese titles should be 3-9 Chinese characters when possible. English titles should be 2-6 words.',
        'Do not include quotes, punctuation, explanations, markdown, or [TITLE] markers.'
    ].join('\n');
    const user = [
        `Latest user message:\n${String(userContent || '').slice(0, 1800)}`,
        '',
        `Assistant reply:\n${String(assistantContent || '').slice(0, 2200)}`
    ].join('\n');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TITLE_FALLBACK_TIMEOUT_MS);
    try {
        const response = await fetch(providerConfig.baseURL, {
            method: 'POST',
            headers: buildProviderFetchHeaders(providerConfig, routing.provider),
            body: JSON.stringify({
                model: routing.model,
                messages: [
                    { role: 'system', content: system },
                    { role: 'user', content: user }
                ],
                temperature: 0.2,
                max_tokens: TITLE_FALLBACK_MAX_TOKENS,
                stream: false
            }),
            signal: controller.signal
        });
        const payloadText = await response.text();
        if (!response.ok) {
            appendRaiRuntimeReport({
                level: '报错',
                tag: 'title_fallback_http_failed',
                message: `Title fallback HTTP ${response.status}`,
                context: { modelId, provider: routing.provider, body: payloadText.slice(0, 600) }
            });
            return null;
        }

        let payload = null;
        try {
            payload = JSON.parse(payloadText);
        } catch {
            payload = null;
        }
        const content = payload?.choices?.[0]?.message?.content || payloadText;
        return sanitizeGeneratedConversationTitle(content, uiLanguage);
    } catch (error) {
        appendRaiRuntimeReport({
            level: '报错',
            tag: 'title_fallback_failed',
            message: error.message,
            context: { modelId, provider: routing.provider }
        });
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

async function generateFallbackConversationTitle({ userContent = '', assistantContent = '', uiLanguage = '' } = {}) {
    for (const modelId of TITLE_FALLBACK_MODEL_IDS) {
        const title = await generateFallbackConversationTitleWithModel({
            modelId,
            userContent,
            assistantContent,
            uiLanguage
        });
        if (title) return title;
    }
    return null;
}



function buildPresetConversationTitle(userContent = '', uiLanguage = '') {
    const text = String(userContent || '').trim().toLowerCase();
    const isZh = /[\u4e00-\u9fff]/.test(userContent) || /zh|cn|hans|hant|中文|简|繁/i.test(String(uiLanguage || ''));
    const titleMap = {
        '你好': isZh ? '问候' : 'Greeting',
        'hello': isZh ? '问候' : 'Greeting',
        'hi': isZh ? '问候' : 'Greeting',
        '谢谢': isZh ? '致谢' : 'Thanks',
        'thank you': isZh ? '致谢' : 'Thanks',
        'thanks': isZh ? '致谢' : 'Thanks',
        '再见': isZh ? '告别' : 'Goodbye',
        'bye': isZh ? '告别' : 'Goodbye'
    };
    return sanitizeGeneratedConversationTitle(titleMap[text] || userContent, uiLanguage);
}

async function updateSessionOrFlowTitleAndEmit({ res, sessionId, flowId, userId, title } = {}) {
    const trimmedTitle = sanitizeGeneratedConversationTitle(title || '');
    if (!trimmedTitle || !sessionId) return null;

    if (flowId) {
        await syncFlowTitle(flowId, userId, trimmedTitle);
        console.log(` Flow标题已更新: "${trimmedTitle}"`);
    } else {
        await dbRunAsync(
            'UPDATE sessions SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [trimmedTitle, sessionId]
        );
        console.log(` 会话标题已更新: "${trimmedTitle}"`);
    }

    if (res && !res.writableEnded && !res.destroyed) {
        res.write(`data: ${JSON.stringify({
            type: 'title',
            title: trimmedTitle
        })}\n\n`);
    }
    return trimmedTitle;
}

function scheduleFallbackConversationTitleUpdate({ sessionId, flowId, userId, userContent = '', assistantContent = '', uiLanguage = '' } = {}) {
    if (!sessionId) return;
    setTimeout(async () => {
        try {
            const fallbackTitle = await generateFallbackConversationTitle({
                userContent,
                assistantContent,
                uiLanguage
            });
            if (!fallbackTitle) return;
            await updateSessionOrFlowTitleAndEmit({
                res: null,
                sessionId,
                flowId,
                userId,
                title: fallbackTitle
            });
            console.log(` 后台标题兜底已更新: "${fallbackTitle}"`);
        } catch (error) {
            console.warn(` 后台标题兜底失败: ${error.message}`);
            appendRaiRuntimeReport({
                level: '报错',
                tag: 'title_fallback_background_failed',
                message: error.message,
                context: { sessionId, flowId, userId }
            });
        }
    }, 0);
}

const INTERNAL_ASSISTANT_SECTION_TITLES = new Set([
    '分析用户意图',
    '用户意图分析',
    '搜索最新信息',
    '搜索资料',
    '安全判断',
    '安全检查',
    '工具调用',
    '调用工具',
    '搜索策略'
]);

const INTERNAL_ASSISTANT_START_PREFIXES = [
    '**分析用户意图**',
    '分析用户意图',
    '**用户意图分析**',
    '用户意图分析',
    '**搜索最新信息**',
    '搜索最新信息',
    '<ds_safety',
    '<function_calls',
    '用户询问的是',
    '用户想了解'
];

function normalizeAssistantSectionTitle(line = '') {
    return String(line || '')
        .trim()
        .replace(/^#{1,6}\s+/, '')
        .replace(/^[-*+]\s+/, '')
        .replace(/^\*{1,3}/, '')
        .replace(/\*{1,3}$/, '')
        .replace(/[：:]\s*$/, '')
        .trim();
}

function isInternalAssistantSectionHeading(line = '') {
    return INTERNAL_ASSISTANT_SECTION_TITLES.has(normalizeAssistantSectionTitle(line));
}

function isAssistantSectionBoundary(line = '') {
    const trimmed = String(line || '').trim();
    if (!trimmed) return false;
    if (/^#{1,6}\s+\S/.test(trimmed)) return true;
    if (/^\*{1,3}[^*\n]{1,60}\*{1,3}\s*[：:]?$/.test(trimmed)) return true;
    if (/^(?:[一二三四五六七八九十]+|[0-9]+)[、.]\s*\S/.test(trimmed)) return true;
    return /^(?:核心|结论|回答|答案|要点|简单说|总体|根据|DeepSeek|DSV4P|DSv4P|Dsv4p)\b/i.test(trimmed);
}

function removeInternalAssistantSections(text = '') {
    const lines = String(text || '').split(/\r?\n/);
    const kept = [];
    let skipping = false;

    for (const line of lines) {
        if (isInternalAssistantSectionHeading(line)) {
            skipping = true;
            continue;
        }

        if (skipping) {
            if (isAssistantSectionBoundary(line) && !isInternalAssistantSectionHeading(line)) {
                skipping = false;
                kept.push(line);
            }
            continue;
        }

        kept.push(line);
    }

    return kept.join('\n');
}

function sanitizeAssistantVisibleContent(text = '') {
    let output = String(text || '');

    output = output
        .replace(/\bDeepSek\b/g, 'DeepSeek')
        .replace(/\bDeepsek\b/g, 'DeepSeek')
        .replace(/\[object Object\]/g, '')
        .replace(/```(?:xml|html)?\s*<function_calls\b[\s\S]*?<\/function_calls>\s*```/gi, '')
        .replace(/<ds_safety\b[^>]*>[\s\S]*?(?:<\/ds_safety>|$)/gi, '')
        .replace(/<function_calls\b[^>]*>[\s\S]*?(?:<\/function_calls>|$)/gi, '')
        .replace(/<invoke\b[^>]*>[\s\S]*?(?:<\/invoke>|$)/gi, '')
        .replace(/<parameter\b[^>]*>[\s\S]*?(?:<\/parameter>|$)/gi, '')
        .replace(/<\|[^|]+\|>/g, '')
        .replace(/functions\.\w+:\d+/g, '')
        .replace(/(?:^|\n)\s*用户(?:询问的是|想了解|问的是)[^\n]*(?:政治敏感|正常技术问题)[^\n]*(?=\n|$)/g, '\n')
        .replace(/(?:^|\n)\s*这是一个关于[^\n]*(?:正常技术问题|政治敏感)[^\n]*(?=\n|$)/g, '\n');

    output = removeInternalAssistantSections(output);

    if (/^\s*(?:\{[\s\S]*"(?:query|name|arguments)"[\s\S]*\}|\[[\s\S]*"(?:query|name|arguments)"[\s\S]*\])\s*$/.test(output)) {
        return '';
    }

    return output
        .replace(/\n{3,}/g, '\n\n')
        .trimEnd();
}

function shouldHoldAssistantVisibleContent(rawText = '', visibleText = '') {
    const raw = String(rawText || '').trimStart();
    if (!raw) return true;

    const rawLower = raw.toLowerCase();
    for (const prefix of INTERNAL_ASSISTANT_START_PREFIXES) {
        const lowerPrefix = prefix.toLowerCase();
        const slice = rawLower.slice(0, Math.min(rawLower.length, lowerPrefix.length));
        if (lowerPrefix.startsWith(slice) && rawLower.length < lowerPrefix.length) {
            return true;
        }
    }

    return !String(visibleText || '').trim() && raw.length < 4096;
}

async function createSessionRecord({ userId, title, model = 'auto', sessionKind = 'chat' }) {
    await ensureSessionKindColumn();
    const sessionId = `session_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    await dbRunAsync(
        'INSERT INTO sessions (id, user_id, title, model, session_kind) VALUES (?, ?, ?, ?, ?)',
        [sessionId, userId, title || '新对话', model || 'auto', sessionKind || 'chat']
    );
    return sessionId;
}

async function getSessionMessagesBySessionId(sessionId) {
    return dbAllAsync(
        `SELECT id, session_id, role, content, reasoning_content, model,
                enable_search, thinking_mode, internet_mode, sources, process_trace, created_at,
                CASE WHEN attachments IS NOT NULL AND attachments != '' AND attachments != '[]'
                     THEN 1 ELSE 0 END as has_attachments
         FROM messages
         WHERE session_id = ?
         ORDER BY created_at ASC, id ASC`,
        [sessionId]
    );
}

async function migrateLegacyFlowRow(flowRow, userId) {
    await ensureChatFlowSchemaColumns();
    const sessionId = `session_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const legacyMessages = normalizeLegacyFlowMessages(flowRow.chat_history);
    const normalizedCanvasState = normalizeFlowCanvasState(flowRow.canvas_state);
    const insertedMessageIds = [];

    await dbRunAsync('BEGIN IMMEDIATE TRANSACTION');
    try {
        await dbRunAsync(
            'INSERT INTO sessions (id, user_id, title, model, session_kind) VALUES (?, ?, ?, ?, ?)',
            [sessionId, userId, flowRow.title || '新 ChatFlow', 'auto', 'flow']
        );

        for (let index = 0; index < legacyMessages.length; index += 1) {
            const legacyMessage = legacyMessages[index];
            const createdAt = new Date(Date.now() + index).toISOString();
            const insertResult = await dbRunAsync(
                'INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)',
                [sessionId, legacyMessage.role, legacyMessage.content, createdAt]
            );
            insertedMessageIds.push(insertResult.lastID);
        }

        const migratedCanvasState = normalizeFlowCanvasState({
            ...normalizedCanvasState,
            nodes: normalizedCanvasState.nodes.map((node) => {
                if ((node.sourceMessageId === undefined || node.sourceMessageId === null || node.sourceMessageId === '') &&
                    Number.isInteger(node.sourceIndex) &&
                    insertedMessageIds[node.sourceIndex]) {
                    return {
                        ...node,
                        sourceMessageId: insertedMessageIds[node.sourceIndex]
                    };
                }
                return node;
            })
        });

        await dbRunAsync(
            'UPDATE flows SET session_id = ?, canvas_state = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?',
            [sessionId, JSON.stringify(migratedCanvasState), flowRow.id, userId]
        );

        await dbRunAsync('COMMIT');

        return {
            ...flowRow,
            session_id: sessionId,
            canvas_state: JSON.stringify(migratedCanvasState)
        };
    } catch (error) {
        try {
            await dbRunAsync('ROLLBACK');
        } catch (rollbackError) {
            console.warn(' 回滚旧Flow迁移事务失败:', rollbackError.message);
        }
        throw error;
    }
}

async function ensureFlowRecord(flowId, userId) {
    await ensureChatFlowSchemaColumns();
    let flowRow = await dbGetAsync('SELECT * FROM flows WHERE id = ? AND user_id = ?', [flowId, userId]);
    if (!flowRow) return null;

    if (flowRow.session_id) {
        const linkedSession = await dbGetAsync(
            'SELECT id FROM sessions WHERE id = ? AND user_id = ?',
            [flowRow.session_id, userId]
        );
        if (!linkedSession) {
            flowRow = await migrateLegacyFlowRow(flowRow, userId);
        }
    } else {
        flowRow = await migrateLegacyFlowRow(flowRow, userId);
    }

    const normalizedCanvasState = normalizeFlowCanvasState(flowRow.canvas_state);
    const messages = flowRow.session_id ? await getSessionMessagesBySessionId(flowRow.session_id) : [];

    return {
        ...flowRow,
        canvas_state: normalizedCanvasState,
        chat_history: normalizeLegacyFlowMessages(flowRow.chat_history),
        messages
    };
}

async function syncFlowTitle(flowId, userId, title) {
    await ensureChatFlowSchemaColumns();
    const trimmedTitle = String(title || '').trim();
    if (!trimmedTitle) return null;

    const flowRow = await dbGetAsync('SELECT id, session_id FROM flows WHERE id = ? AND user_id = ?', [flowId, userId]);
    if (!flowRow) return null;

    await dbRunAsync(
        'UPDATE flows SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?',
        [trimmedTitle, flowId, userId]
    );

    if (flowRow.session_id) {
        await dbRunAsync(
            'UPDATE sessions SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?',
            [trimmedTitle, flowRow.session_id, userId]
        );
    }

    return {
        title: trimmedTitle,
        sessionId: flowRow.session_id || null
    };
}

function buildFlowCanvasSystemInstruction({ flowRecord, canvasContext, uiSurface, canvasApplyMode }) {
    if (!flowRecord) return '';

    const normalizedCanvasContext = (() => {
        if (!canvasContext) return null;
        if (typeof canvasContext === 'string') {
            try {
                return JSON.parse(canvasContext);
            } catch (error) {
                return null;
            }
        }
        return canvasContext;
    })();

    const flowTitle = String(flowRecord?.title || '新 ChatFlow').trim() || '新 ChatFlow';
    const mobilePrompt = uiSurface === 'chatflow-mobile'
        ? '\n4. 当前界面是移动端 ChatFlow 浮窗，请优先给出简短、直接、便于继续操作画布的回答。'
        : '';
    const canvasModeHint = canvasApplyMode === 'direct'
        ? '当前用户偏好是直接应用画布修改。'
        : '当前用户偏好是审核后应用画布修改。';
    const serializedContext = normalizedCanvasContext
        ? JSON.stringify(normalizedCanvasContext)
        : JSON.stringify({
            nodes: flowRecord.canvas_state?.nodes || [],
            edges: flowRecord.canvas_state?.edges || [],
            viewport: flowRecord.canvas_state?.viewport || FLOW_DEFAULT_CANVAS_STATE.viewport,
            selectedNodeIds: [],
            flowTitle
        });

    return [
        `当前处于 ChatFlow 专属会话，Flow 标题为「${flowTitle}」。`,
        '你可以结合当前画布上下文回答，但不要把画布上下文原样复述给用户。',
        '如果你认为应该修改画布，请在正常回答之外，追加一个隐藏结构化区块，格式必须严格为：[CANVAS_OPS]{...}[/CANVAS_OPS]。',
        '可用操作仅限：add_node、update_node、delete_node、add_edge、update_edge、delete_edge、auto_layout。',
        '不要输出自由手绘、整张清空或图片节点相关操作。',
        canvasModeHint,
        '标题仍需在回复末尾使用 [TITLE]标题[/TITLE] 生成，标题简短即可。',
        mobilePrompt,
        `当前画布上下文(JSON): ${serializedContext}`
    ].filter(Boolean).join('\n');
}

// 获取用户的 Flow 列表
app.get('/api/flows', authenticateToken, async (req, res) => {
    try {
        await ensureChatFlowSchemaColumns();
        db.all(
            `SELECT f.id, f.title, f.session_id, f.created_at, f.updated_at,
                    (SELECT content FROM messages WHERE session_id = f.session_id ORDER BY created_at DESC, id DESC LIMIT 1) as last_message
             FROM flows f
             WHERE f.user_id = ?
             ORDER BY f.updated_at DESC`,
            [req.user.userId],
            (err, rows) => {
                if (err) {
                    console.error(' 获取Flow列表失败:', err);
                    return res.status(500).json({ error: '获取Flow列表失败' });
                }
                res.json(rows);
            }
        );
    } catch (error) {
        console.error(' 确保Flow表结构失败:', error);
        res.status(500).json({ error: '数据库结构初始化失败' });
    }
});

// 创建新 Flow
app.post('/api/flows', authenticateToken, async (req, res) => {
    const { title = '新 ChatFlow' } = req.body;
    const id = `flow-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

    try {
        await ensureChatFlowSchemaColumns();
        await dbRunAsync('BEGIN IMMEDIATE TRANSACTION');
        const sessionId = await createSessionRecord({
            userId: req.user.userId,
            title,
            model: 'auto',
            sessionKind: 'flow'
        });
        await dbRunAsync(
            `INSERT INTO flows (id, user_id, title, session_id) VALUES (?, ?, ?, ?)`,
            [id, req.user.userId, title, sessionId]
        );
        await dbRunAsync('COMMIT');

        console.log(' 创建ChatFlow成功:', id);
        res.json({
            id,
            title,
            session_id: sessionId,
            created_at: new Date().toISOString()
        });
    } catch (error) {
        try {
            await dbRunAsync('ROLLBACK');
        } catch (rollbackError) {
            console.warn(' 回滚创建Flow事务失败:', rollbackError.message);
        }
        console.error(' 创建Flow失败:', error);
        res.status(500).json({ error: error.message });
    }
});

// 获取单个 Flow 详情
app.get('/api/flows/:id', authenticateToken, async (req, res) => {
    try {
        await ensureChatFlowSchemaColumns();
        const flow = await ensureFlowRecord(req.params.id, req.user.userId);
        if (!flow) {
            return res.status(404).json({ error: 'Flow not found' });
        }

        res.json({
            ...flow,
            session_id: flow.session_id || null
        });
    } catch (error) {
        console.error(' 获取Flow详情失败:', error);
        res.status(500).json({ error: error.message });
    }
});

// 更新 Flow
app.put('/api/flows/:id', authenticateToken, async (req, res) => {
    const { title, chat_history, canvas_state: canvasStateInput } = req.body;

    try {
        await ensureChatFlowSchemaColumns();
        const currentFlow = await dbGetAsync(
            'SELECT id, user_id, session_id FROM flows WHERE id = ? AND user_id = ?',
            [req.params.id, req.user.userId]
        );
        if (!currentFlow) {
            return res.status(404).json({ error: 'Flow not found' });
        }

        const updates = [];
        const params = [];

        if (title !== undefined) {
            updates.push('title = ?');
            params.push(String(title || '').trim() || '新 ChatFlow');
        }

        if (canvasStateInput !== undefined) {
            updates.push('canvas_state = ?');
            params.push(JSON.stringify(normalizeFlowCanvasState(canvasStateInput)));
        }

        updates.push('updated_at = CURRENT_TIMESTAMP');
        params.push(req.params.id, req.user.userId);

        await dbRunAsync(
            `UPDATE flows SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`,
            params
        );

        if (title !== undefined && currentFlow.session_id) {
            await dbRunAsync(
                'UPDATE sessions SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?',
                [String(title || '').trim() || '新 ChatFlow', currentFlow.session_id, req.user.userId]
            );
        }

        if (chat_history !== undefined) {
            console.warn(` Flow ${req.params.id} 收到废弃字段 chat_history，已忽略`);
        }

        console.log(' 更新ChatFlow成功:', req.params.id);
        res.json({ success: true });
    } catch (error) {
        console.error(' 更新Flow失败:', error);
        res.status(500).json({ error: error.message });
    }
});

// 删除 Flow
app.delete('/api/flows/:id', authenticateToken, async (req, res) => {
    try {
        await ensureChatFlowSchemaColumns();
        const flow = await dbGetAsync(
            'SELECT id, session_id FROM flows WHERE id = ? AND user_id = ?',
            [req.params.id, req.user.userId]
        );
        if (!flow) {
            return res.status(404).json({ error: 'Flow not found' });
        }

        await dbRunAsync('BEGIN IMMEDIATE TRANSACTION');
        await dbRunAsync(
            'DELETE FROM flows WHERE id = ? AND user_id = ?',
            [req.params.id, req.user.userId]
        );
        if (flow.session_id) {
            await dbRunAsync(
                'DELETE FROM sessions WHERE id = ? AND user_id = ? AND COALESCE(session_kind, ?) = ?',
                [flow.session_id, req.user.userId, 'flow', 'flow']
            );
        }
        await dbRunAsync('COMMIT');

        console.log(' 删除ChatFlow成功:', req.params.id);
        res.json({ success: true });
    } catch (error) {
        try {
            await dbRunAsync('ROLLBACK');
        } catch (rollbackError) {
            console.warn(' 回滚删除Flow事务失败:', rollbackError.message);
        }
        console.error(' 删除Flow失败:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==================== 消息管理API ====================

// 懒加载消息附件（避免初始加载时传输大量Base64数据）
app.get('/api/messages/:messageId/attachments', authenticateToken, (req, res) => {
    const { messageId } = req.params;

    db.get(
        `SELECT m.attachments, s.user_id 
         FROM messages m 
         JOIN sessions s ON m.session_id = s.id 
         WHERE m.id = ?`,
        [messageId],
        (err, row) => {
            if (err) {
                console.error(' 获取附件失败:', err);
                return res.status(500).json({ error: '数据库错误' });
            }

            if (!row) {
                return res.status(404).json({ error: '消息不存在' });
            }

            if (row.user_id !== req.user.userId) {
                return res.status(403).json({ error: '无权访问' });
            }

            // 解析并返回附件
            let attachments = [];
            if (row.attachments) {
                try {
                    attachments = JSON.parse(row.attachments);
                } catch (e) {
                    attachments = [];
                }
            }

            res.json({ attachments });
        }
    );
});

// 删除单条消息
app.delete('/api/sessions/:sessionId/messages/:messageId', authenticateToken, (req, res) => {
    const { sessionId, messageId } = req.params;

    // 验证会话归属
    db.get('SELECT user_id FROM sessions WHERE id = ?', [sessionId], (err, session) => {
        if (err) {
            console.error(' 查询会话失败:', err);
            return res.status(500).json({ error: '数据库错误' });
        }

        if (!session || session.user_id !== req.user.userId) {
            return res.status(403).json({ error: '无权访问此会话' });
        }

        // 删除指定消息
        db.run('DELETE FROM messages WHERE id = ? AND session_id = ?', [messageId, sessionId], function (err) {
            if (err) {
                console.error(' 删除消息失败:', err);
                return res.status(500).json({ error: '删除失败' });
            }

            if (this.changes === 0) {
                return res.status(404).json({ error: '消息不存在' });
            }

            console.log(` 已删除消息 ID: ${messageId}`);
            res.json({ success: true, deletedId: messageId });
        });
    });
});

// 编辑消息内容
app.put('/api/sessions/:sessionId/messages/:messageId', authenticateToken, (req, res) => {
    const { sessionId, messageId } = req.params;
    const { content } = req.body;

    if (!content || typeof content !== 'string') {
        return res.status(400).json({ error: '内容不能为空' });
    }

    // 验证会话归属
    db.get('SELECT user_id FROM sessions WHERE id = ?', [sessionId], (err, session) => {
        if (err) {
            console.error(' 查询会话失败:', err);
            return res.status(500).json({ error: '数据库错误' });
        }

        if (!session || session.user_id !== req.user.userId) {
            return res.status(403).json({ error: '无权访问此会话' });
        }

        // 更新消息内容
        db.run('UPDATE messages SET content = ? WHERE id = ? AND session_id = ?',
            [content, messageId, sessionId],
            function (err) {
                if (err) {
                    console.error(' 更新消息失败:', err);
                    return res.status(500).json({ error: '更新失败' });
                }

                if (this.changes === 0) {
                    return res.status(404).json({ error: '消息不存在' });
                }

                console.log(` 已更新消息 ID: ${messageId}`);
                res.json({ success: true, updatedId: messageId, content });
            }
        );
    });
});

// 标记旧AI回复为重新生成前一版：保留数据库内容，但前端默认折叠且不进入后续上下文。
app.patch('/api/sessions/:sessionId/messages/:messageId/regeneration', authenticateToken, async (req, res) => {
    const { sessionId, messageId } = req.params;
    const replacementMessageId = req.body?.replacementMessageId || null;

    try {
        const row = await dbGetAsync(
            `SELECT m.id, m.role, m.process_trace, s.user_id
             FROM messages m
             JOIN sessions s ON m.session_id = s.id
             WHERE m.id = ? AND m.session_id = ?`,
            [messageId, sessionId]
        );

        if (!row || row.user_id !== req.user.userId) {
            return res.status(404).json({ error: '消息不存在' });
        }
        if (row.role !== 'assistant') {
            return res.status(400).json({ error: '只能标记 AI 回复' });
        }

        let processTrace = {};
        if (row.process_trace) {
            try {
                const parsed = typeof row.process_trace === 'string'
                    ? JSON.parse(row.process_trace)
                    : row.process_trace;
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    processTrace = parsed;
                }
            } catch (e) {
                processTrace = { legacyProcessTrace: String(row.process_trace).slice(0, 4000) };
            }
        }

        processTrace.regeneration = {
            ...(processTrace.regeneration && typeof processTrace.regeneration === 'object' ? processTrace.regeneration : {}),
            state: 'previous_collapsed',
            collapsed: true,
            userVisibleOnly: true,
            excludeFromContext: true,
            replacementMessageId: replacementMessageId ? Number(replacementMessageId) || String(replacementMessageId) : null,
            updatedAt: new Date().toISOString()
        };

        const serialized = JSON.stringify(processTrace);
        await dbRunAsync(
            'UPDATE messages SET process_trace = ? WHERE id = ? AND session_id = ?',
            [serialized, messageId, sessionId]
        );

        res.json({ success: true, messageId, process_trace: serialized });
    } catch (error) {
        console.error(' 标记重新生成旧回复失败:', error);
        res.status(500).json({ error: '标记失败' });
    }
});

// 获取指定消息之前的所有消息（用于重新生成）
app.get('/api/sessions/:sessionId/messages-before/:messageId', authenticateToken, (req, res) => {
    const { sessionId, messageId } = req.params;

    // 验证会话归属
    db.get('SELECT user_id FROM sessions WHERE id = ?', [sessionId], (err, session) => {
        if (err) {
            console.error(' 查询会话失败:', err);
            return res.status(500).json({ error: '数据库错误' });
        }

        if (!session || session.user_id !== req.user.userId) {
            return res.status(403).json({ error: '无权访问此会话' });
        }

        // 获取目标消息的创建时间
        db.get('SELECT created_at FROM messages WHERE id = ? AND session_id = ?',
            [messageId, sessionId],
            (err, targetMsg) => {
                if (err || !targetMsg) {
                    return res.status(404).json({ error: '消息不存在' });
                }

                // 获取该消息之前的所有消息
                db.all(
                    'SELECT * FROM messages WHERE session_id = ? AND created_at < ? ORDER BY created_at ASC, id ASC',
                    [sessionId, targetMsg.created_at],
                    (err, messages) => {
                        if (err) {
                            console.error(' 获取消息失败:', err);
                            return res.status(500).json({ error: '数据库错误' });
                        }
                        res.json(messages);
                    }
                );
            }
        );
    });
});

// ==================== AI聊天路由 ====================

async function enforceUploadPreflight(req, res, next) {
    try {
        const settings = await getAdminRuntimeSettings();
        const uploadQuota = await checkAndConsumeWindowUsage({
            userId: req.user.userId,
            windowType: 'upload_minute',
            seconds: 60,
            limit: Number(settings.upload_per_minute || 0),
            label: '每分钟上传'
        });
        if (!uploadQuota.allowed) {
            return res.status(429).json({
                error: `${uploadQuota.label}额度已用完，请稍后再试`,
                code: 'upload_rate_limited',
                quota: uploadQuota
            });
        }
        const contentLength = Number(req.headers['content-length'] || 0);
        if (contentLength > 0) {
            await assertUserUploadQuota(req.user.userId, contentLength);
        }
        next();
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : '上传额度检查失败' });
    }
}

app.post('/api/upload', authenticateToken, enforceUploadPreflight, (req, res, next) => runUpload(attachmentUpload.single('file'), req, res, next), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: '没有文件上传' });

    try {
        await assertUserUploadQuota(req.user.userId, Number(req.file.size || 0));
        await validateUploadedFileContent(req.file, 'attachment');
        await recordUploadedFile(req, req.file, 'attachment');
        const forwardedPrefix = normalizeForwardedPrefix(req);
        console.log(' 文件上传成功:', req.file.filename);
        res.json({
            success: true,
            file: {
                filename: req.file.filename,
                originalName: req.file.originalname,
                filePath: `${forwardedPrefix}/api/uploads/${req.file.filename}`,
                fileType: req.file.mimetype,
                size: req.file.size
            }
        });
    } catch (error) {
        fs.unlink(req.file.path, () => null);
        console.error(' 记录上传文件归属失败:', error.message);
        res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : '文件上传失败' });
    }
});

app.get('/api/uploads/:filename', authenticateToken, async (req, res) => {
    const filename = path.basename(req.params.filename || '');
    if (!filename || filename !== req.params.filename || filename.includes('..')) {
        return res.status(400).json({ error: '无效文件名' });
    }

    const ext = path.extname(filename).toLowerCase().slice(1);
    if (!ATTACHMENT_EXTENSIONS.has(ext) || BLOCKED_UPLOAD_EXTENSIONS.has(ext)) {
        return res.status(404).json({ error: '文件不存在' });
    }

    const uploadRoot = path.resolve(__dirname, 'uploads');
    const filePath = path.resolve(uploadRoot, filename);
    if (!(filePath === uploadRoot || filePath.startsWith(`${uploadRoot}${path.sep}`))) {
        return res.status(400).json({ error: '无效文件名' });
    }

    try {
        const allowed = await userCanAccessUploadedFile(filename, req.user.userId);
        if (!allowed) {
            return res.status(404).json({ error: '文件不存在' });
        }

        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.download(filePath, filename, (err) => {
            if (err && !res.headersSent) {
                res.status(err.code === 'ENOENT' ? 404 : 500).json({ error: '文件下载失败' });
            }
        });
    } catch (error) {
        console.error(' 校验上传文件归属失败:', error.message);
        res.status(500).json({ error: '文件下载失败' });
    }
});

const activeRequestInterjections = new Map();

function normalizeStreamingInterjection(value = '') {
    return String(value || '')
        .replace(/\r\n/g, '\n')
        .trim()
        .slice(0, 1200);
}

function pushRequestInterjection(requestId, text, userId) {
    const content = normalizeStreamingInterjection(text);
    if (!requestId || !content) return null;
    const item = {
        userId,
        content,
        createdAt: new Date().toISOString()
    };
    const list = activeRequestInterjections.get(requestId) || [];
    list.push(item);
    activeRequestInterjections.set(requestId, list.slice(-20));
    return item;
}

function collectRequestInterjections(requestId) {
    const list = activeRequestInterjections.get(requestId) || [];
    if (list.length > 0) {
        activeRequestInterjections.set(requestId, []);
    }
    return list;
}

//  修复：流式聊天路由
app.post('/api/chat/stream', authenticateToken, apiLimiter, async (req, res) => {
    console.log(' 收到聊天请求');

    let requestId = null;  //  关键修复：在函数开始声明requestId
    let liveStreamState = null;

    try {
        const {
            sessionId: requestedSessionId,
            flowId,
            messages: rawMessages,
            model: requestedModel = 'auto',  // 默认为auto模式
            thinkingMode: thinkingModeInput = false,
            thinkingBudget = 1024,
            internetMode = true,
            agentMode = 'off',
            agentPolicy = AGENT_DEFAULT_POLICY,
            qualityProfile = AGENT_DEFAULT_QUALITY,
            agentTraceLevel = 'full',
            reasoningProfile = 'low',
            researchMode = 'off',
            researchAgentModels = null,
            researchMasterModel = '',
            researchMaxRounds = null,
            temperature = 0.7,
            top_p = 0.9,
            max_tokens = 2000,
            frequency_penalty = 0,
            presence_penalty = 0,
            systemPrompt,
            promptTimeContext = null,
            domainMode = '',
            uiLanguage = '',
            canvasContext = null,
            canvasApplyMode = 'review',
            uiSurface = '',
            memoryMode = 'normal',
            skipUserSave = false
        } = req.body;
        let sessionId = requestedSessionId;
        let flowRecord = null;
        let activeSessionKind = '';
        let thinkingMode = !!thinkingModeInput;
        let model = normalizeIncomingModelId(requestedModel);
        const shouldSkipUserSave = skipUserSave === true || skipUserSave === 1 || skipUserSave === '1';
        let normalizedReasoningProfile = normalizeReasoningProfile(reasoningProfile);
        const normalizedResearchMode = normalizeResearchMode(researchMode);
        const rawResearchAgentModels = Array.isArray(researchAgentModels)
            ? researchAgentModels
            : (typeof researchAgentModels === 'string' ? researchAgentModels.split(',') : []);
        if (rawResearchAgentModels.length > 4) {
            return res.status(400).json({ error: '研究模式子模型最多选择 4 个，请取消一个不需要的模型。' });
        }
        const normalizedResearchAgentModels = normalizeResearchAgentModels(rawResearchAgentModels);
        const normalizedResearchMasterModel = normalizeResearchMasterModel(researchMasterModel || requestedModel);
        const normalizedResearchMaxRounds = Math.max(
            1,
            Math.min(
                parseInt(researchMaxRounds, 10) || (normalizeResearchMode(researchMode) === 'deep' ? 3 : 2),
                50
            )
        );
        const normalizedPromptTimeContext = normalizePromptTimeContext(promptTimeContext);

        const sanitizedChatInput = sanitizeClientChatMessages(rawMessages);
        const messages = sanitizedChatInput.messages;
        if (!Array.isArray(messages) || messages.length === 0) {
            return res.status(400).json({ error: '消息不能为空' });
        }
        if (sanitizedChatInput.rejectedRoles.length > 0) {
            console.warn(` 已拒绝客户端消息角色: ${[...new Set(sanitizedChatInput.rejectedRoles)].join(', ')}`);
        }

        if (normalizedResearchMode === 'fast') {
            thinkingMode = false;
        } else if (normalizedResearchMode === 'deep') {
            thinkingMode = true;
            normalizedReasoningProfile = 'mixed';
        }

        console.log(` 接收参数: model=${model}, thinking=${thinkingMode}, internet=${internetMode}, agentMode=${agentMode}, researchMode=${normalizedResearchMode}, researchMaxRounds=${normalizedResearchMaxRounds}, policy=${agentPolicy}, quality=${qualityProfile}, trace=${agentTraceLevel}, reasoningProfile=${normalizedReasoningProfile}`);
        if (requestedModel !== model) {
            console.log(` 已将旧模型ID ${requestedModel} 归一化为 ${model}`);
        }

        //  调试：打印收到的消息结构
        console.log(` 收到 ${messages.length} 条消息:`);
        messages.forEach((m, i) => {
            const messageItem = m || {};
            const hasValidAttachments = Array.isArray(messageItem.attachments);
            console.log(`   [${i}] role=${messageItem.role}, hasAttachments=${hasValidAttachments}, attachmentsCount=${hasValidAttachments ? messageItem.attachments.length : 0}`);
            if (hasValidAttachments && messageItem.attachments.length > 0) {
                console.log(`       附件详情:`, messageItem.attachments.map(a => ({ type: a.type, fileName: a.fileName, hasData: !!a.data, fileId: a.fileId })));
            }
        });

        //  附件解析层：将最后一条用户消息的附件内容转为文本上下文追加到 prompt
        if (messages.length > 0) {
            const lastMsg = messages[messages.length - 1];
            if (lastMsg.role === 'user' && Array.isArray(lastMsg.attachments) && lastMsg.attachments.length > 0) {
                try {
                    const attachmentContext = await buildAttachmentPromptContext(lastMsg.attachments, req.user.userId);
                    if (attachmentContext) {
                        lastMsg.content = (typeof lastMsg.content === 'string' ? lastMsg.content : '') + attachmentContext;
                        console.log(` 已注入附件上下文到用户消息 (${attachmentContext.length} 字符)`);
                    }
                } catch (attCtxErr) {
                    console.warn(' 构建附件上下文失败:', attCtxErr.message);
                }
            }
        }

        if (flowId) {
            flowRecord = await ensureFlowRecord(flowId, req.user.userId);
            if (!flowRecord) {
                return res.status(404).json({ error: 'Flow not found' });
            }
            sessionId = flowRecord.session_id || null;
        }

        // 验证会话所有权
        if (sessionId) {
            const session = await new Promise((resolve, reject) => {
                db.get('SELECT user_id, session_kind FROM sessions WHERE id = ?', [sessionId], (err, row) => {
                    if (err) reject(err);
                    else resolve(row);
                });
            });

            if (!session || session.user_id !== req.user.userId) {
                return res.status(403).json({ error: '无权访问此会话' });
            }
            activeSessionKind = String(session.session_kind || 'chat');
        }

        const runtimeSettings = await getAdminRuntimeSettings();
        const concurrentLimit = Math.max(1, Number(runtimeSettings.concurrent_requests || MAX_CONCURRENT_REQUESTS_PER_USER));
        requestId = `req_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
        const activeRegistration = await registerActiveRequestForUser({
            requestId,
            userId: req.user.userId,
            sessionId: sessionId || 'anonymous',
            limit: concurrentLimit
        });
        if (!activeRegistration.allowed) {
            return res.status(429).json({
                error: `每个用户最多同时运行 ${concurrentLimit} 个请求，请等待其中一个完成或停止后再试`,
                code: 'user_concurrency_limit',
                limit: concurrentLimit,
                active: activeRegistration.active
            });
        }

        const chatQuota = await checkAndConsumeChatQuota(req.user.userId);
        if (!chatQuota.allowed) {
            const blocked = chatQuota.blocked || {};
            const resetText = blocked.resetAt
                ? new Date(blocked.resetAt).toLocaleString('zh-CN', { hour12: false })
                : '';
            await dbRunAsync('DELETE FROM active_requests WHERE id = ?', [requestId]).catch(() => null);
            return res.status(429).json({
                error: `${blocked.label || '当前'}额度已用完，请稍后再试${resetText ? `（重置时间 ${resetText}）` : ''}`,
                code: 'chat_quota_exceeded',
                quota: {
                    type: blocked.type,
                    label: blocked.label,
                    limit: blocked.limit,
                    used: blocked.used,
                    remaining: 0,
                    resetAt: blocked.resetAt,
                    windows: chatQuota.quotas
                }
            });
        }

        const memoryModeOff = String(memoryMode || '').toLowerCase() === 'off' || activeSessionKind === 'temporary_saved';
        let promptUserProfile = null;
        let conversationMemoryInstruction = '';
        if (!memoryModeOff) {
            try {
                promptUserProfile = await getPromptUserProfile(req.user.userId, req.user.email);
                if (await isUserLongMemoryEnabled(req.user.userId)) {
                    conversationMemoryInstruction = await buildConversationMemoryPrompt(req.user.userId);
                }
            } catch (promptUserProfileError) {
                console.warn(` 获取Prompt用户信息失败，使用令牌回退: ${promptUserProfileError.message}`);
                promptUserProfile = await getPromptUserProfile(null, req.user.email);
            }
        } else {
            console.log(` 临时对话 memoryMode=off，跳过用户身份/偏好/长期记忆注入: userId=${req.user.userId}, sessionKind=${activeSessionKind || 'none'}`);
        }
        const userIdentityInstruction = memoryModeOff ? '' : buildUserIdentityPrompt(promptUserProfile);
        if (userIdentityInstruction) {
            console.log(` 已注入当前用户信息到Prompt: userId=${req.user.userId}, hasUsername=${!!promptUserProfile?.username}, hasEmail=${!!promptUserProfile?.email}`);
        }

        if (
            model === 'claude-haiku' ||
            model === 'anthropic/claude-sonnet-4.6' ||
            model === 'anthropic/claude-3-haiku'
        ) {
            const membershipSnapshot = await getUserMembershipSnapshot(req.user.userId);
            const membershipTier = String(membershipSnapshot?.membership || 'free').toLowerCase();
            if (membershipTier !== 'max') {
                return res.status(403).json({ error: '该模型仅 MAX 会员可用' });
            }
        }

        if (model !== 'auto' && await isPublicModelDisabled(model)) {
            console.warn(` 模型 ${model} 已被管理员关闭，回退到 智能模型`);
            model = 'auto';
        }

        //  防御性检查：验证 messages 存在且非空
        if (!Array.isArray(messages) || messages.length === 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: '消息不能为空' }));
            db.run('DELETE FROM active_requests WHERE id = ?', [requestId]);
            return;
        }

        //  关键修复：在所有 res.write() 调用之前，先设置 SSE 响应头
        // 这确保后续所有的 res.write() 都能正常工作
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.setHeader('X-Request-ID', requestId);
        // 注意：X-Model-Used 在后面确定最终模型后再设置
        res.flushHeaders();  // 立即发送头部，开始SSE流
        res.write(`data: ${JSON.stringify({
            type: 'quota_info',
            scope: 'chat',
            windows: chatQuota.quotas || []
        })}\n\n`);

        //  预设答案快速通道：在所有路由逻辑之前检查，确保所有模式都能生效
        const lastUserMsg = messages[messages.length - 1];
        const rawUserContent = typeof lastUserMsg.content === 'string'
            ? lastUserMsg.content
            : JSON.stringify(lastUserMsg.content);
        const userContent = stripInlinePromptTimeHint(rawUserContent);
        const imageGenerationRequested = detectImageGenerationNeed(userContent);
        const memoryDeleteToolArgs = !memoryModeOff
            ? buildMemoryDeleteToolArgsFromConversation(userContent, messages)
            : null;
        const memoryDeleteToolRequested = !memoryModeOff && (
            !!memoryDeleteToolArgs || detectMemoryDeleteToolNeed(userContent, messages)
        );
        const runtimeToolDefinitions = buildChatToolDefinitions({
            internetMode,
            imageGenerationRequested,
            memoryDeleteToolRequested
        });
        const promptContextTrace = buildPromptContextTrace(normalizedPromptTimeContext);

        if (sessionId) {
            liveStreamState = getSessionStreamState(sessionId, requestId, req.user.userId);
            if (liveStreamState) {
                liveStreamState.userContent = userContent;
                liveStreamState.status = 'running';
                liveStreamState.updatedAt = Date.now();
                persistSessionStreamDraft(liveStreamState, true);
                broadcastSessionStreamState(liveStreamState, 'session_stream_snapshot');
            }
        }

        console.log(` 分析消息: "${userContent.substring(0, 100)}${userContent.length > 100 ? '...' : ''}"`);

        if (memoryDeleteToolArgs && sessionId && !flowId && !shouldSkipUserSave) {
            console.log(` 记忆删除直达路径: userId=${req.user.userId}, args=${JSON.stringify(memoryDeleteToolArgs)}`);
            res.write(`data: ${JSON.stringify({
                type: 'tool_status',
                tool: 'delete_memory',
                status: 'running',
                message: '正在删除指定记忆'
            })}\n\n`);

            const deleteResult = await deleteUserMemoryByModel({
                userId: req.user.userId,
                memoryId: memoryDeleteToolArgs.memory_id,
                memoryIds: memoryDeleteToolArgs.memory_ids,
                target: memoryDeleteToolArgs.target,
                reason: memoryDeleteToolArgs.reason
            });
            const deletedMemoryIds = uniquePositiveMemoryIds([
                Array.isArray(deleteResult?.deletedMemories) ? deleteResult.deletedMemories.map((memory) => memory?.id) : [],
                deleteResult?.deletedMemory?.id,
                memoryDeleteToolArgs.memory_ids,
                memoryDeleteToolArgs.memory_id
            ]);
            const deletedMemoryIdList = formatMemoryIdList(deletedMemoryIds);
            const deletedCount = Number(deleteResult?.deletedCount || deletedMemoryIds.length || 0);
            const assistantReply = deleteResult?.success
                ? (deletedMemoryIdList
                    ? (deletedCount > 1 ? `已删除 ${deletedMemoryIdList} 这 ${deletedCount} 条记忆。` : `已删除 ${deletedMemoryIdList} 这条记忆。`)
                    : `已删除 ${deletedCount} 条匹配的记忆。`)
                : (deleteResult?.message || '没有找到要删除的那条记忆。你可以告诉我记忆编号，例如“删除 #12”。');

            await dbRunAsync(
                'INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)',
                [sessionId, 'user', userContent, new Date().toISOString()]
            );
            await dbRunAsync(
                'INSERT INTO messages (session_id, role, content, model, enable_search, thinking_mode, internet_mode, process_trace, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [
                    sessionId,
                    'assistant',
                    assistantReply,
                    'memory-tool',
                    0,
                    0,
                    0,
                    promptContextTrace ? JSON.stringify(promptContextTrace) : null,
                    new Date().toISOString()
                ]
            );

            await updateSessionOrFlowTitleAndEmit({
                res,
                sessionId,
                flowId,
                userId: req.user.userId,
                title: '记忆清理'
            });
            await dbRunAsync('UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [sessionId]);

            const updatedMemories = await listActiveUserMemories(req.user.userId, 200).catch(() => []);
            res.write(`data: ${JSON.stringify({
                type: 'tool_status',
                tool: 'delete_memory',
                status: deleteResult?.success ? 'complete' : 'no_results',
                message: deleteResult?.message || assistantReply
            })}\n\n`);
            res.write(`data: ${JSON.stringify({
                type: 'memory_update',
                enabled: true,
                memories: updatedMemories
            })}\n\n`);
            res.write(`data: ${JSON.stringify({ type: 'content', content: assistantReply })}\n\n`);
            res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
            res.end();
            console.log(` 记忆删除直达完成: success=${!!deleteResult?.success}, deleted=${Number(deleteResult?.deletedCount || 0)}`);
            return;
        }

        let agentRuntime = {
            enabled: false,
            agentMode: 'off',
            agentPolicy: normalizeAgentPolicy(agentPolicy),
            qualityProfile: normalizeQualityProfile(qualityProfile),
            selectedAgents: [],
            fingerprint: null,
            retriesUsed: 0
        };

        const presetAnswers = {
            '你好': '你好！很高兴见到你 ',
            '谢谢': '不客气！很高兴能帮到你 ',
            '再见': '再见！期待下次与你交谈 ',
            'hello': 'Hello! Nice to meet you!',
            'hi': 'Hi there! How can I help you?',
            'thank you': 'You\'re welcome!',
            'thanks': 'You\'re welcome!',
            'bye': 'Goodbye! See you next time!'
        };

        const trimmedContent = userContent.trim().toLowerCase();
        const presetAnswer = presetAnswers[trimmedContent] || presetAnswers[userContent.trim()]; // 兼容原始大小写

        if (presetAnswer) {
            console.log(`\n 命中预设答案: "${userContent.trim()}" -> 直接返回，无需调用AI`);

            // SSE头已在前面设置，直接发送预设答案
            res.write(`data: ${JSON.stringify({ type: 'content', content: presetAnswer })}\n\n`);

            // 保存到数据库
            if (sessionId) {
                console.log('\n 保存预设答案到数据库');

                // 保存用户消息
                await new Promise((resolve) => {
                    db.run(
                        'INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)',
                        [sessionId, 'user', userContent],
                        (err) => {
                            if (err) console.error(' 保存用户消息失败:', err);
                            else console.log(` 用户消息已保存 (${userContent.length}字符)`);
                            resolve();
                        }
                    );
                });

                // 保存预设答案
                await new Promise((resolve) => {
                    db.run(
                        'INSERT INTO messages (session_id, role, content, model, enable_search, thinking_mode, internet_mode, process_trace) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                        [sessionId, 'assistant', presetAnswer, 'preset', 0, 0, 0, promptContextTrace ? JSON.stringify(promptContextTrace) : null],
                        (err) => {
                            if (err) console.error(' 保存预设答案失败:', err);
                            else console.log(` 预设答案已保存 (${presetAnswer.length}字符)`);
                            resolve();
                        }
                    );
                });

                // 更新会话时间戳
                await new Promise((resolve) => {
                    db.run(
                        'UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                        [sessionId],
                        (err) => {
                            if (err) console.error(' 更新会话时间戳失败:', err);
                            else console.log(' 会话时间戳已更新');
                            resolve();
                        }
                    );
                });

                if (!memoryModeOff && !flowId) {
                    scheduleConversationMemoryProcessing({
                        userId: req.user.userId,
                        sessionId,
                        userContent,
                        assistantContent: presetAnswer
                    });
                }

                const presetTitle = buildPresetConversationTitle(userContent, uiLanguage);
                if (presetTitle) {
                    await updateSessionOrFlowTitleAndEmit({
                        res,
                        sessionId,
                        flowId,
                        userId: req.user.userId,
                        title: presetTitle
                    });
                }
            }

            res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
            res.end();
            db.run('DELETE FROM active_requests WHERE id = ?', [requestId]);
            console.log('\n 预设答案处理完成（0成本）\n');
            return;
        }

        const resolvedPromptRule = resolvePromptInjection(userContent);
        const activeRuleInstruction = buildRuleInjectionInstruction(resolvedPromptRule);
        if (resolvedPromptRule) {
            const matched = (resolvedPromptRule.matchedKeywords || []).join(', ');
            console.log(` RULE_HIT id=${resolvedPromptRule.ruleId} matched=[${matched}]`);
            res.write(`data: ${JSON.stringify({
                type: 'rule_injection',
                ruleId: resolvedPromptRule.ruleId,
                matchedKeywords: resolvedPromptRule.matchedKeywords || [],
                appliedStages: normalizeAgentMode(agentMode) === 'on'
                    ? ['planner', 'sub', 'synthesis']
                    : ['single']
            })}\n\n`);
        }

        const resolvedDomainPrompt = resolveDomainSystemPrompt({
            domainMode,
            uiLanguage,
            userMessage: userContent
        });
        const activeDomainInstruction = buildDomainInjectionInstruction(resolvedDomainPrompt);
        if (resolvedDomainPrompt) {
            console.log(` DOMAIN_PROMPT mode=${resolvedDomainPrompt.domainMode} lang=${resolvedDomainPrompt.promptLanguage}`);
            res.write(`data: ${JSON.stringify({
                type: 'domain_injection',
                domainMode: resolvedDomainPrompt.domainMode,
                language: resolvedDomainPrompt.promptLanguage
            })}\n\n`);
        }

        let userMembershipTier = 'free';
        try {
            const membershipStatus = await getUserMembershipSnapshot(req.user.userId);
            userMembershipTier = String(membershipStatus?.membership || 'free');
        } catch (tierErr) {
            console.warn(` 读取会员等级失败，按free处理: ${tierErr.message}`);
            userMembershipTier = 'free';
        }
        const normalizedMembershipTier = String(userMembershipTier || 'free').toLowerCase();
        const normalizedAgentMode = normalizeAgentMode(agentMode);
        let effectiveAgentMode = normalizedAgentMode;
        const agentHardDisabled = process.env.AGENT_HARD_DISABLE === '1';
        let pointsAlreadyDeducted = false;
        let forceFreeModelByQuota = false;

        if (normalizedAgentMode === 'on' && normalizedMembershipTier !== 'max') {
            effectiveAgentMode = 'off';
            emitAgentEvent(res, {
                type: 'agent_status',
                role: 'master',
                scope: 'stage',
                stepId: 'master',
                status: 'failed',
                detail: '高级研究仅 MAX 会员可用，已自动回退单模型'
            });
            console.warn(` 用户 ${req.user.userId} 非MAX会员，跳过Agent模式`);
        }

        // Agent模式默认走高质量模型，先做点数检查，避免后续失败后再回退
        if (normalizedAgentMode === 'on' && effectiveAgentMode === 'on' && !agentHardDisabled) {
            try {
                const agentPoints = await checkAndDeductPoints(req.user.userId, 'kimi-k2.6');
                if (agentPoints?.useFreeModel) {
                    forceFreeModelByQuota = true;
                    effectiveAgentMode = 'off';
                    res.write(`data: ${JSON.stringify({
                        type: 'points_info',
                        remainingPoints: 0,
                        message: agentPoints.message || '点数不足，已自动切换到免费模型。完成任务或签到可增加积分。'
                    })}\n\n`);
                    emitAgentEvent(res, {
                        type: 'agent_status',
                        role: 'master',
                        scope: 'stage',
                        stepId: 'master',
                        status: 'failed',
                        detail: '点数不足，已自动回退到免费模型路径'
                    });
                    console.warn(` 用户 ${req.user.userId} 点数不足，跳过Agent模式`);
                } else {
                    pointsAlreadyDeducted = Number(agentPoints?.pointsDeducted || 0) > 0;
                    if (pointsAlreadyDeducted) {
                        console.log(` Agent请求已扣点: user=${req.user.userId}, remaining=${agentPoints.remainingPoints}`);
                    }
                }
            } catch (pointsErr) {
                forceFreeModelByQuota = true;
                effectiveAgentMode = 'off';
                emitAgentEvent(res, {
                    type: 'agent_status',
                    role: 'master',
                    scope: 'stage',
                    stepId: 'master',
                    status: 'failed',
                    detail: '点数检查失败，已回退免费模型路径'
                });
                console.error(` Agent点数检查失败，回退免费模型: ${pointsErr.message}`);
            }
        }

        if (normalizedAgentMode === 'on') {
            if (agentHardDisabled) {
                console.warn(' AGENT_HARD_DISABLE=1，强制回退单模型路径');
                emitAgentEvent(res, {
                    type: 'agent_status',
                    role: 'master',
                    scope: 'stage',
                    stepId: 'master',
                    status: 'failed',
                    detail: '服务端已禁用Agent模式，自动回退单模型'
                });
                effectiveAgentMode = 'off';
            } else if (effectiveAgentMode !== 'on') {
                // 前置点数检查已判定回退，不再进入并行Agent调用
                console.warn(' Agent模式已因点数/策略回退到单模型路径');
            } else {
                try {
                    const agentTraceState = {
                        version: 1,
                        mode: 'agent',
                        policy: normalizeAgentPolicy(agentPolicy),
                        qualityProfile: normalizeQualityProfile(qualityProfile),
                        plan: null,
                        tasks: {},
                        statuses: [],
                        drafts: [],
                        quality: [],
                        retry: [],
                        metrics: null,
                        savedAt: null
                    };

                    const onAgentEvent = (payload) => {
                        const event = payload && typeof payload === 'object' ? payload : null;
                        if (!event || !event.type) return;

                        if (event.type === 'agent_plan') {
                            agentTraceState.plan = event;
                            if (Array.isArray(event.tasks)) {
                                for (const task of event.tasks) {
                                    const taskId = Number(task.agent_id || 0);
                                    if (!taskId) continue;
                                    const stepId = `task-${taskId}`;
                                    agentTraceState.tasks[stepId] = {
                                        stepId,
                                        taskId,
                                        role: task.role || 'custom',
                                        status: 'pending',
                                        detail: task.task || '',
                                        durationMs: null
                                    };
                                }
                            }
                            return;
                        }

                        if (event.type === 'agent_status') {
                            const statusEvent = {
                                type: event.type,
                                scope: event.scope || 'stage',
                                stepId: event.stepId || '',
                                taskId: event.taskId || null,
                                role: event.role || '',
                                status: event.status || 'pending',
                                detail: event.detail || '',
                                durationMs: event.durationMs || null,
                                ts: Date.now()
                            };
                            agentTraceState.statuses.push(statusEvent);
                            if (agentTraceState.statuses.length > 400) {
                                agentTraceState.statuses = agentTraceState.statuses.slice(-400);
                            }

                            const isTask = statusEvent.scope === 'task' || (statusEvent.stepId && statusEvent.stepId.startsWith('task-'));
                            if (isTask) {
                                const stepId = statusEvent.stepId || `task-${statusEvent.taskId || 0}`;
                                const prev = agentTraceState.tasks[stepId] || {};
                                agentTraceState.tasks[stepId] = {
                                    ...prev,
                                    stepId,
                                    taskId: statusEvent.taskId || prev.taskId || null,
                                    role: statusEvent.role || prev.role || 'custom',
                                    status: statusEvent.status || prev.status || 'pending',
                                    detail: statusEvent.detail || prev.detail || '',
                                    durationMs: statusEvent.durationMs != null ? statusEvent.durationMs : (prev.durationMs || null)
                                };
                            }
                            return;
                        }

                        if (event.type === 'agent_draft') {
                            agentTraceState.drafts.push(event);
                            if (agentTraceState.drafts.length > 20) {
                                agentTraceState.drafts = agentTraceState.drafts.slice(-20);
                            }
                            return;
                        }

                        if (event.type === 'agent_draft_delta') {
                            if (!Array.isArray(agentTraceState.draftDeltas)) {
                                agentTraceState.draftDeltas = [];
                            }
                            agentTraceState.draftDeltas.push({
                                taskId: event.taskId || null,
                                stepId: event.stepId || '',
                                role: event.role || '',
                                task: event.task || '',
                                reset: !!event.reset,
                                delta: String(event.delta || ''),
                                ts: Date.now()
                            });
                            if (agentTraceState.draftDeltas.length > 800) {
                                agentTraceState.draftDeltas = agentTraceState.draftDeltas.slice(-800);
                            }
                            return;
                        }

                        if (event.type === 'agent_quality') {
                            agentTraceState.quality.push(event);
                            if (agentTraceState.quality.length > 20) {
                                agentTraceState.quality = agentTraceState.quality.slice(-20);
                            }
                            return;
                        }

                        if (event.type === 'agent_retry') {
                            agentTraceState.retry.push(event);
                            if (agentTraceState.retry.length > 20) {
                                agentTraceState.retry = agentTraceState.retry.slice(-20);
                            }
                            return;
                        }

                        if (event.type === 'agent_metrics') {
                            agentTraceState.metrics = event;
                        }
                    };

                    console.log('\n 启用真并行 Multi-Agent 模式 (K2.6)\n');
                    const agentResult = await runTrueParallelAgentMode({
                        res,
                        messages,
                        userMessage: userContent,
                        systemPrompt,
                        userIdentityInstruction,
                        domainInstruction: activeDomainInstruction,
                        ruleInstruction: activeRuleInstruction,
                        ruleMeta: resolvedPromptRule
                            ? {
                                ruleId: resolvedPromptRule.ruleId,
                                matchedKeywords: resolvedPromptRule.matchedKeywords || []
                            }
                            : null,
                        thinkingMode,
                        thinkingBudget,
                        internetMode,
                        qualityProfile,
                        maxTokens: max_tokens,
                        agentTraceLevel,
                        onAgentEvent
                    });

                    let contentToSave = String(agentResult?.content || '').trim();
                    contentToSave = contentToSave
                        .replace(/<\|[^|]+\|>/g, '')
                        .replace(/functions\.\w+:\d+/g, '')
                        .trim();
                    const reasoningToSave = String(agentResult?.reasoningContent || '').trim();
                    const searchSources = dedupeSources(Array.isArray(agentResult?.sources) ? agentResult.sources : []);
                    const finalModel = agentResult?.finalModel || 'kimi-k2.6';
                    agentTraceState.savedAt = new Date().toISOString();
                    const processTraceJson = JSON.stringify({
                        version: agentTraceState.version,
                        mode: agentTraceState.mode,
                        policy: agentTraceState.policy,
                        qualityProfile: agentTraceState.qualityProfile,
                        plan: agentTraceState.plan,
                        tasks: Object.values(agentTraceState.tasks || {}).sort((a, b) => Number(a.taskId || 0) - Number(b.taskId || 0)),
                        statuses: agentTraceState.statuses,
                        drafts: agentTraceState.drafts,
                        quality: agentTraceState.quality,
                        retry: agentTraceState.retry,
                        metrics: agentTraceState.metrics,
                        draftDeltas: agentTraceState.draftDeltas || [],
                        savedAt: agentTraceState.savedAt,
                        prompt_context: promptContextTrace?.prompt_context || null
                    });
                    const structuredAgentOutput = parseStructuredAssistantOutput(contentToSave);
                    contentToSave = structuredAgentOutput.visibleContent || contentToSave;
                    const directTitle = sanitizeGeneratedConversationTitle(structuredAgentOutput.extractedTitle || '', uiLanguage);

                    if (sessionId) {
                        console.log('\n 保存真并行 Agent 结果到数据库');

                        const lastUserMessage = messages[messages.length - 1];
                        if (lastUserMessage && lastUserMessage.role === 'user') {
                            const lastUserContent = typeof lastUserMessage.content === 'string'
                                ? lastUserMessage.content
                                : JSON.stringify(lastUserMessage.content);

                            let attachmentsJson = null;
                            if (Array.isArray(lastUserMessage.attachments) && lastUserMessage.attachments.length > 0) {
                                const previewAttachments = lastUserMessage.attachments.map(att => {
                                    if (att.type === 'image' && att.data) {
                                        return {
                                            type: 'image',
                                            fileName: att.fileName,
                                            data: att.data
                                        };
                                    }
                                    return {
                                        type: att.type,
                                        fileName: att.fileName
                                    };
                                });
                                attachmentsJson = JSON.stringify(previewAttachments);
                            }

                            await new Promise((resolve, reject) => {
                                db.run(
                                    'INSERT INTO messages (session_id, role, content, attachments, created_at) VALUES (?, ?, ?, ?, ?)',
                                    [sessionId, 'user', lastUserContent, attachmentsJson, new Date().toISOString()],
                                    (err) => err ? reject(err) : resolve()
                                );
                            });
                        }

                        const sourcesJson = searchSources.length > 0 ? JSON.stringify(searchSources) : null;
                        await new Promise((resolve, reject) => {
                            db.run(
                                'INSERT INTO messages (session_id, role, content, reasoning_content, model, enable_search, thinking_mode, internet_mode, sources, process_trace, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                                [
                                    sessionId,
                                    'assistant',
                                    contentToSave || '(生成中断)',
                                    reasoningToSave || null,
                                    finalModel,
                                    internetMode ? 1 : 0,
                                    thinkingMode ? 1 : 0,
                                    internetMode ? 1 : 0,
                                    sourcesJson,
                                    processTraceJson,
                                    new Date().toISOString()
                                ],
                                (err) => err ? reject(err) : resolve()
                            );
                        });

                        if (directTitle) {
                            await updateSessionOrFlowTitleAndEmit({
                                res,
                                sessionId,
                                flowId,
                                userId: req.user.userId,
                                title: directTitle
                            });
                        } else {
                            scheduleFallbackConversationTitleUpdate({
                                sessionId,
                                flowId,
                                userId: req.user.userId,
                                userContent,
                                assistantContent: contentToSave,
                                uiLanguage
                            });
                        }

                        await new Promise((resolve) => {
                            db.run(
                                'UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                                [sessionId],
                                () => resolve()
                            );
                        });

                        if (!memoryModeOff && !flowId) {
                            scheduleConversationMemoryProcessing({
                                userId: req.user.userId,
                                sessionId,
                                userContent,
                                assistantContent: contentToSave || ''
                            });
                        }
                    }

                    if (flowId && structuredAgentOutput.canvasPatchRaw) {
                        res.write(`data: ${JSON.stringify({
                            type: 'canvas_patch',
                            patch: structuredAgentOutput.canvasPatch,
                            raw: structuredAgentOutput.canvasPatchRaw,
                            valid: !structuredAgentOutput.canvasPatchParseError,
                            error: structuredAgentOutput.canvasPatchParseError || null
                        })}\n\n`);
                    }

                    if (liveStreamState) {
                        liveStreamState.assistantContent = contentToSave || '(生成中断)';
                        liveStreamState.reasoningContent = reasoningToSave || '';
                        liveStreamState.model = finalModel;
                        liveStreamState.status = 'done';
                        liveStreamState.updatedAt = Date.now();
                        await persistSessionStreamDraft(liveStreamState, true);
                        broadcastSessionStreamState(liveStreamState, 'session_stream_done');
                        cleanupSessionStreamState(sessionId, requestId);
                    }

                    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
                    res.end();
                    console.log('\n 真并行 Multi-Agent 处理完成\n');
                    return;
                } catch (agentPipelineError) {
                    console.error(' 真并行Agent流程失败，回退单模型路径:', agentPipelineError.message);
                    emitAgentEvent(res, {
                        type: 'agent_status',
                        role: 'master',
                        scope: 'stage',
                        stepId: 'master',
                        status: 'failed',
                        detail: '并行Agent异常，已回退单模型流程'
                    });
                    effectiveAgentMode = 'off';
                }
            }
        }

        try {
            agentRuntime = runAgentOrchestrator({
                res,
                userMessage: userContent,
                internetMode,
                agentMode: effectiveAgentMode,
                agentPolicy,
                qualityProfile
            });
        } catch (agentError) {
            console.error(' Multi-Agent 编排初始化失败，回退单模型路径:', agentError.message);
            emitAgentEvent(res, {
                type: 'agent_status',
                role: 'master',
                status: 'error',
                detail: '编排初始化失败，已自动回退单模型流程'
            });
            agentRuntime = {
                enabled: false,
                agentMode: 'off',
                agentPolicy: normalizeAgentPolicy(agentPolicy),
                qualityProfile: normalizeQualityProfile(qualityProfile),
                selectedAgents: [],
                fingerprint: null,
                retriesUsed: 0
            };
        }

        // 智能路由：根据最后一条用户消息自动选择模型
        let finalModel = model;  // 最终选中的模型类型
        let routing = null;      // 对应的路由配置
        let autoRoutingReason = '';

        console.log(`\n 模型选择开始: 用户指定 = ${model}`);

        // 关键修复：只检测【当前用户消息】的多模态内容，而不是整个对话历史！
        // 这样只有当前消息带图片才会用 VL 模型，之前对话中的图片不会影响后续消息
        const lastUserMessage = messages.filter(m => m.role === 'user').pop();
        const currentMessageMultimodal = lastUserMessage ? detectMultimodalContent(lastUserMessage) : { hasMultimodal: false, types: [], count: 0 };
        let isMultimodalRequest = currentMessageMultimodal.hasMultimodal;

        if (isMultimodalRequest) {
            console.log(`\n   当前消息检测到多模态内容!!!`);
            console.log(`   类型: ${getMultimodalTypeDescription(currentMessageMultimodal.types)}`);
            console.log(`   数量: ${currentMessageMultimodal.count}`);

            const multimodalTypesText = getMultimodalTypeDescription(currentMessageMultimodal.types);
            const defaultMultimodalModel = model === 'auto' ? await resolveVisibleAutoMultimodalModel() : model;
            const requestedRouting = MODEL_ROUTING[defaultMultimodalModel];
            const supportsNativeMultimodal = model === 'auto' || !!requestedRouting?.multimodal;

            if (supportsNativeMultimodal) {
                finalModel = defaultMultimodalModel;
                autoRoutingReason = model === 'auto'
                    ? `${userMembershipTier} 用户 智能模型使用 Qwen 3.6 处理${multimodalTypesText}`
                    : `${defaultMultimodalModel} 原生支持多模态，直接处理${multimodalTypesText}`;
                console.log(`    模型 ${finalModel} 原生支持多模态，无需切换`);
            } else {
                finalModel = 'qwen3.6-35b-a3b';
                autoRoutingReason = `${model || 'auto'} 不支持多模态，自动切换到 Qwen 3.6 处理${multimodalTypesText}`;
                console.log(`    ${model || 'auto'} 不支持多模态，切换到 qwen3.6-35b-a3b (Qwen/Qwen3.6-35B-A3B)`);
            }
        } else if (model === 'auto') {
            // 智能模型策略：纯文本默认 DeepSeek Pro；文档类附件会被转成文本后继续走这里。
            finalModel = await resolveVisibleAutoModel();
            autoRoutingReason = `${userMembershipTier} 用户 智能模型默认使用 ${finalModel}`;
            console.log(` auto_route_decision: ${autoRoutingReason}`);
        }


        // Auto + 联网：优先保证可用性，失败时走统一备用链
        if (model === 'auto' && internetMode) {
            console.log(` Auto+联网模式: 使用 ${finalModel}（支持联网）`);
        }

        let enableResearchDebate = (normalizedResearchMode === 'fast' || normalizedResearchMode === 'deep') && !isMultimodalRequest;
        if ((normalizedResearchMode === 'fast' || normalizedResearchMode === 'deep') && isMultimodalRequest) {
            emitAgentEvent(res, {
                type: 'agent_status',
                role: 'master',
                scope: 'stage',
                stepId: 'research-master',
                status: 'failed',
                detail: '当前消息包含图片/多模态内容，研究讨论已自动降级为单模型处理'
            });
            console.warn(' 研究讨论暂不处理多模态当前消息，回退单模型处理');
        }

        if (enableResearchDebate) {
            const preferredMaster = normalizeResearchMasterModel(normalizedResearchMasterModel || finalModel);
            const availableMaster = await resolveAvailableResearchModel(preferredMaster);
            if (await isRoutableModelAvailable(availableMaster)) {
                finalModel = availableMaster;
            } else {
                enableResearchDebate = false;
                emitAgentEvent(res, {
                    type: 'agent_status',
                    role: 'master',
                    scope: 'stage',
                    stepId: 'research-master',
                    status: 'failed',
                    detail: '深度研究主控模型不可用，已自动降级为单模型深度思考'
                });
                console.warn(' 深度研究互评主控模型不可用，回退单模型');
            }

            if (enableResearchDebate) {
                const researchAgentLabels = normalizedResearchAgentModels.map((modelId) => researchModelLabel(modelId)).join(' + ');
                autoRoutingReason = `${normalizedResearchMode === 'deep' ? '深度研究' : '快速研究'}讨论: ${researchAgentLabels} 轮流质疑，由 ${researchModelLabel(finalModel)} 主控判断停止并回答`;
                console.log(` research_debate enabled mode=${normalizedResearchMode} master=${finalModel}`);
            }
        }

        //  关键修复：添加白名单验证（防御性编程）
        const VALID_MODELS = [
            'deepseek-flash',
            'deepseek-pro',
            'qwen3.6-35b-a3b',
            'kimi-k2.6',
            'kimi-k2',
            'chatgpt-gpt-oss-120b',
            'north-mini-code',
            'nemotron-3-ultra',
            'openrouter-free',
            'claude-haiku',
            'anthropic/claude-sonnet-4.6',
            'anthropic/claude-3-haiku',
            'gemma',
            'gemini-3-flash'
        ];

        // 注意：多模态检测已在上面执行，这里不再重复

        if (!VALID_MODELS.includes(finalModel) || await isPublicModelDisabled(finalModel)) {
            const fallbackModel = resolveFreeFallbackModelId(finalModel);
            const visibleFallbackModel = await isPublicModelDisabled(fallbackModel)
                ? await resolveVisibleAutoModel()
                : fallbackModel;
            console.warn(` 无效或已关闭模型 ${finalModel},回退到 ${visibleFallbackModel}`);
            finalModel = visibleFallbackModel;
            autoRoutingReason = `无效或已关闭模型,按备用链自动回退到 ${visibleFallbackModel}`;
        }

        if (forceFreeModelByQuota && !isFreeModelIdentifier(finalModel)) {
            const fallbackModel = resolveFreeFallbackModelId(finalModel, { requiresMultimodal: isMultimodalRequest });
            finalModel = fallbackModel;
            autoRoutingReason = autoRoutingReason
                ? `${autoRoutingReason}; 点数不足按备用链自动切换到 ${fallbackModel}，完成任务或签到可增加积分`
                : `点数不足按备用链自动切换到 ${fallbackModel}，完成任务或签到可增加积分`;
            console.log(` 点数不足强制免费模型: user=${req.user.userId}`);
        } else if (!forceFreeModelByQuota && !pointsAlreadyDeducted) {
            try {
                const pointsResult = await checkAndDeductPoints(req.user.userId, finalModel);
                if (pointsResult?.useFreeModel && !isFreeModelIdentifier(finalModel)) {
                    const fallbackModel = resolveFreeFallbackModelId(finalModel, { requiresMultimodal: isMultimodalRequest });
                    finalModel = fallbackModel;
                    res.write(`data: ${JSON.stringify({
                        type: 'points_info',
                        remainingPoints: 0,
                        message: pointsResult.message || '点数不足，已自动切换到免费模型。完成任务或签到可增加积分。'
                    })}\n\n`);
                    autoRoutingReason = autoRoutingReason
                        ? `${autoRoutingReason}; 点数不足按备用链自动切换到 ${fallbackModel}，完成任务或签到可增加积分`
                        : `点数不足按备用链自动切换到 ${fallbackModel}，完成任务或签到可增加积分`;
                    console.log(` 点数不足自动切换免费模型: user=${req.user.userId}`);
                } else if (Number(pointsResult?.pointsDeducted || 0) > 0) {
                    pointsAlreadyDeducted = true;
                    console.log(` 已扣点: user=${req.user.userId}, remaining=${pointsResult.remainingPoints}`);
                }
            } catch (pointsErr) {
                const fallbackModel = resolveFreeFallbackModelId(finalModel, { requiresMultimodal: isMultimodalRequest });
                finalModel = fallbackModel;
                autoRoutingReason = autoRoutingReason
                    ? `${autoRoutingReason}; 点数检查失败，按备用链回退到 ${fallbackModel}`
                    : `点数检查失败，按备用链回退到 ${fallbackModel}`;
                console.error(` 点数检查失败，回退免费模型: ${pointsErr.message}`);
            }
        }

        // 关键修复：现在finalModel已经是具体的模型名，再获取routing
        routing = MODEL_ROUTING[finalModel];
        if (!routing) {
            console.error(` 模型路由配置未找到: ${finalModel}`);
            res.write(`data: ${JSON.stringify({ type: 'error', error: `配置错误: ${finalModel}` })}\n\n`);
            res.end();
            db.run('DELETE FROM active_requests WHERE id = ?', [requestId]);
            return;
        }

        console.log(`\n 路由配置: provider=${routing.provider}, model=${routing.model}`);

        let actualModel = routing.model;

        // DeepSeek Pro 使用 thinking 参数控制深度推理；Flash 保持快速路径。
        if (routing.provider === 'deepseek' && thinkingMode && routing.thinkingModel) {
            actualModel = routing.thinkingModel;
            console.log(` DeepSeek Pro 思考模式: 使用 ${actualModel}`);
        }

        // Kimi K2.6 思考模式自动切换
        if ((finalModel === 'kimi-k2.6' || finalModel === 'kimi-k2') && thinkingMode && routing.thinkingModel) {
            actualModel = routing.thinkingModel;
            console.log(` Kimi K2.6 思考模式: 切换到 ${actualModel}`);
        }

        //  关键修复：验证提供商配置存在（防止404错误）
        let providerConfig = API_PROVIDERS[routing.provider];
        if (!providerConfig || !providerConfig.apiKey) {
            const fallbackModel = findAvailableRuntimeFallbackModelId(finalModel);
            if (fallbackModel) {
                const missingReason = !providerConfig
                    ? `提供商配置缺失: ${routing.provider}`
                    : `缺少环境变量: ${providerConfig.envKey || 'API_KEY'}`;
                console.warn(` ${missingReason}，按备用链回退到 ${fallbackModel}`);
                finalModel = fallbackModel;
                routing = MODEL_ROUTING[finalModel];
                actualModel = routing.model;
                providerConfig = API_PROVIDERS[routing.provider];
                autoRoutingReason = autoRoutingReason
                    ? `${autoRoutingReason}; ${missingReason}，按备用链回退到 ${fallbackModel}`
                    : `${missingReason}，按备用链回退到 ${fallbackModel}`;
            }
        }
        if (!providerConfig) {
            console.error(` API提供商配置未找到: ${routing.provider}`);
            appendRaiRuntimeReport({
                level: '报错',
                tag: 'model_provider_config_missing',
                message: `provider config missing for ${routing.provider}`,
                context: {
                    sessionId,
                    requestId,
                    requestedModel: model,
                    finalModel,
                    provider: routing.provider
                }
            });
            res.write(`data: ${JSON.stringify({ type: 'error', error: buildUserFacingApiFailureMessage() })}\n\n`);
            res.end();
            db.run('DELETE FROM active_requests WHERE id = ?', [requestId]);
            return;
        }
        if (!providerConfig.apiKey) {
            const missingEnvKey = providerConfig.envKey || 'API_KEY';
            console.error(` 缺少API环境变量: ${missingEnvKey}`);
            appendRaiRuntimeReport({
                level: '报错',
                tag: 'model_provider_token_missing',
                message: `provider token missing for ${routing.provider}`,
                context: {
                    sessionId,
                    requestId,
                    requestedModel: model,
                    finalModel,
                    provider: routing.provider,
                    envKey: missingEnvKey
                }
            });
            res.write(`data: ${JSON.stringify({ type: 'error', error: buildUserFacingApiFailureMessage() })}\n\n`);
            res.end();
            db.run('DELETE FROM active_requests WHERE id = ?', [requestId]);
            return;
        }

        console.log(` API端点: ${providerConfig.baseURL}`);

        // 关键修复：通过SSE发送实际使用的模型信息（因为响应头已经发送，无法再设置X-Model-Used）
        if (liveStreamState) {
            liveStreamState.model = finalModel;
            liveStreamState.updatedAt = Date.now();
            persistSessionStreamDraft(liveStreamState, false);
            broadcastSessionStreamState(liveStreamState, 'session_stream_snapshot');
        }
        res.write(`data: ${JSON.stringify({
            type: 'model_info',
            model: finalModel,
            actualModel: actualModel,
            reason: autoRoutingReason,
            provider: routing.provider
        })}\n\n`);
        console.log(` 已发送模型信息: finalModel=${finalModel}, actualModel=${actualModel}`);

        //  流式工具调用模式 (Streaming Function Calling)
        // 不再预先判断，而是在流式响应中检测 tool_calls
        let searchContext = '';
        let searchSources = [];
        let useStreamingTools = false;  // 标记是否启用流式工具调用

        if (enableResearchDebate && internetMode) {
            try {
                res.write(`data: ${JSON.stringify({
                    type: 'search_status',
                    status: 'searching',
                    query: userContent,
                    message: `正在搜索: "${userContent.slice(0, 80)}"`
                })}\n\n`);
                const researchSearchData = await performWebSearch(userContent, 5, getTavilySearchDepth(actualModel, true));
                const researchSearchResults = researchSearchData?.results || researchSearchData || [];
                if (Array.isArray(researchSearchResults) && researchSearchResults.length > 0) {
                    searchContext = formatSearchResults(researchSearchData, userContent);
                    const currentSources = extractSourcesForSSE(researchSearchResults);
                    const sourceAppendResult = appendAnnotatedSources(searchSources, currentSources);
                    searchSources = sourceAppendResult.merged;
                    emitSourcesEvent(res, sourceAppendResult.newlyAdded);
                    res.write(`data: ${JSON.stringify({
                        type: 'search_status',
                        status: 'complete',
                        query: userContent,
                        resultCount: researchSearchResults.length,
                        message: `找到 ${researchSearchResults.length} 条结果`
                    })}\n\n`);
                    console.log(` 深度研究预检索完成: ${researchSearchResults.length} 条结果`);
                } else {
                    res.write(`data: ${JSON.stringify({
                        type: 'search_status',
                        status: 'no_results',
                        query: userContent,
                        message: '未找到相关结果'
                    })}\n\n`);
                }
            } catch (searchError) {
                console.warn(` 深度研究预检索失败，继续无联网上下文: ${searchError.message}`);
                res.write(`data: ${JSON.stringify({
                    type: 'search_status',
                    status: 'no_results',
                    query: userContent,
                    message: '搜索暂不可用，已继续深度研究'
                })}\n\n`);
            }
        } else if (shouldUseServerSideSearchContext({
            internetMode,
            routing,
            userMessage: userContent,
            enableResearchDebate,
            isMultimodalRequest
        })) {
            try {
                const serverSearchQuery = buildServerSideSearchQuery(userContent) || userContent;
                res.write(`data: ${JSON.stringify({
                    type: 'search_status',
                    status: 'searching',
                    query: serverSearchQuery,
                    originalQuery: userContent,
                    message: `正在搜索: "${serverSearchQuery.slice(0, 80)}"`
                })}\n\n`);

                const serverSearchData = await performWebSearch(serverSearchQuery, 5, getTavilySearchDepth(actualModel, false));
                const serverSearchResults = serverSearchData?.results || serverSearchData || [];
                if (Array.isArray(serverSearchResults) && serverSearchResults.length > 0) {
                    searchContext = formatSearchResults(serverSearchData, serverSearchQuery);
                    const currentSources = extractSourcesForSSE(serverSearchResults);
                    const sourceAppendResult = appendAnnotatedSources(searchSources, currentSources);
                    searchSources = sourceAppendResult.merged;
                    emitSourcesEvent(res, sourceAppendResult.newlyAdded);
                    res.write(`data: ${JSON.stringify({
                        type: 'search_status',
                        status: 'complete',
                        query: serverSearchQuery,
                        originalQuery: userContent,
                        resultCount: serverSearchResults.length,
                        message: `找到 ${serverSearchResults.length} 条结果`
                    })}\n\n`);
                    console.log(` DeepSeek 服务端预检索完成: ${serverSearchResults.length} 条结果`);
                } else {
                    res.write(`data: ${JSON.stringify({
                        type: 'search_status',
                        status: 'no_results',
                        query: serverSearchQuery,
                        originalQuery: userContent,
                        message: '未找到相关结果'
                    })}\n\n`);
                    console.log(' DeepSeek 服务端预检索无结果');
                }
            } catch (searchError) {
                console.warn(` DeepSeek 服务端预检索失败，继续无联网上下文: ${searchError.message}`);
                res.write(`data: ${JSON.stringify({
                    type: 'search_status',
                    status: 'no_results',
                    query: buildServerSideSearchQuery(userContent) || userContent,
                    originalQuery: userContent,
                    message: '搜索暂不可用，已继续生成'
                })}\n\n`);
            }
        }

        if (
            !enableResearchDebate &&
            runtimeToolDefinitions.length > 0 &&
            routing.provider !== 'aliyun' &&
            (routing.supportsWebSearch !== false || imageGenerationRequested || memoryDeleteToolRequested)
        ) {
            console.log(` 工具模式: 启用流式工具调用 (Streaming Function Calling), tools=${runtimeToolDefinitions.length}, internet=${internetMode}, image=${imageGenerationRequested}, memoryDelete=${memoryDeleteToolRequested}`);
            useStreamingTools = true;
            // 不再阻塞等待，直接在后面的流式调用中添加 tools 参数
        } else if (!enableResearchDebate && internetMode && finalModel === 'deepseek-pro') {
            console.log(searchContext
                ? ` DeepSeek Pro 使用服务端预检索上下文`
                : ` DeepSeek Pro 未启用流式工具调用`);
        }

        // 构建消息数组
        let finalMessages = [...messages];

        // 如果是多模态请求，转换消息格式为Omni格式
        if (isMultimodalRequest) {
            finalMessages = await convertMessagesToOmniFormat(finalMessages, req.user.userId);
            console.log(` 消息已转换为多模态格式`);
        }

        // 添加系统提示词（包含搜索结果）
        // 注意: Mermaid 图表生成指南已内置在前端的 buildSystemPrompt() 中
        let systemContent = searchContext
            ? `${systemPrompt || ''}\n${searchContext}`.trim()
            : systemPrompt || '';

        if (routing.provider === 'deepseek') {
            const deepseekOutputGuard = searchContext
                ? '上方网页搜索结果已由 RAI 服务端完成。请直接基于这些来源回答，使用 [1]、[2] 等角标引用；不要输出“分析用户意图”“搜索最新信息”、<ds_safety>、<function_calls>、web_search 或任何工具调用原文。'
                : '请只输出面向用户的最终答案。不要输出“分析用户意图”“搜索最新信息”、安全审查文本、<ds_safety>、<function_calls>、web_search 或任何工具调用原文。';
            systemContent = systemContent
                ? `${systemContent}\n\n[系统提示] ${deepseekOutputGuard}`
                : `[系统提示] ${deepseekOutputGuard}`;
        }

        //  流式工具调用：在系统提示词中告知 AI 它有搜索能力
        if (useStreamingTools) {
            const toolHints = [];
            if (internetMode) {
                toolHints.push('当前处于联网模式。若用户要求“最新/实时/文献/论文/来源/数据依据/研究结论”，请至少调用一次 web_search 再回答；涉及天气、新闻、股价、时效数据时也应按需调用，并可在必要时再次调用。');
            }
            if (imageGenerationRequested) {
                toolHints.push(`用户正在请求生成图片。请调用 generate_image 工具，模型固定为 ${KOLORS_IMAGE_MODEL}；只传 prompt/image_size/batch_size 等文生图参数，禁止传 image、image_url、示例图片 URL 或上游临时 URL。服务端会先展示本站短链接图片，后续回复只需简短说明。`);
            }
            const toolHint = `\n\n[系统提示] ${toolHints.join(' ')}`;
            systemContent = systemContent ? `${systemContent}${toolHint}` : toolHint.trim();
            console.log(` 已添加工具提示到系统提示词`);
        }

        if (userIdentityInstruction) {
            systemContent = systemContent
                ? `${systemContent}\n\n${userIdentityInstruction}`
                : userIdentityInstruction;
            console.log(` 已注入当前用户信息到系统提示词`);
        }

        if (conversationMemoryInstruction) {
            systemContent = systemContent
                ? `${systemContent}\n\n${conversationMemoryInstruction}`
                : conversationMemoryInstruction;
            console.log(` 已注入跨对话记忆与近期标题到系统提示词`);
        }

        if (activeDomainInstruction) {
            systemContent = systemContent
                ? `${systemContent}\n\n${activeDomainInstruction}`
                : activeDomainInstruction;
            console.log(` 已注入领域系统提示词: ${resolvedDomainPrompt?.domainMode || 'unknown'}`);
        }

        if (activeRuleInstruction) {
            systemContent = systemContent
                ? `${systemContent}\n\n${activeRuleInstruction}`
                : activeRuleInstruction;
            console.log(` 已注入规则提示到系统提示词: ${resolvedPromptRule?.ruleId || 'unknown'}`);
        }

        if (flowRecord) {
            const flowCanvasInstruction = buildFlowCanvasSystemInstruction({
                flowRecord,
                canvasContext,
                uiSurface,
                canvasApplyMode
            });
            if (flowCanvasInstruction) {
                systemContent = systemContent
                    ? `${systemContent}\n\n${flowCanvasInstruction}`
                    : flowCanvasInstruction;
                console.log(` 已注入 ChatFlow 专属上下文: flow=${flowRecord.id}, session=${flowRecord.session_id}`);
            }
        }

        if (systemContent) {
            finalMessages.unshift({
                role: 'system',
                content: systemContent
            });
        }

        const isKimiK25Model = (finalModel === 'kimi-k2.6' || finalModel === 'kimi-k2' || isKimiK25ActualModel(actualModel));
        const isQwen36A3BModel = (finalModel === 'qwen3.6-35b-a3b' || isQwen36A3BActualModel(actualModel));

        // 构建API请求体
        let requestBody = {
            model: actualModel,
            messages: finalMessages,
            max_tokens: parseInt(max_tokens, 10) || 2000,
            stream: true
        };
        if (routing.provider === 'openrouter' && Array.isArray(routing.fallbackModels) && routing.fallbackModels.length > 1) {
            requestBody.models = routing.fallbackModels;
            console.log(` OpenRouter fallback models: ${routing.fallbackModels.join(' -> ')}`);
        }

        // Kimi K2.6 参数规则：
        // 1) 默认思考开启；要快速响应需显式关闭思考
        // 2) 对 K2.6 不传可变采样参数，避免参数冲突
        if (isKimiK25Model) {
            if (routing.provider === 'siliconflow') {
                // SiliconFlow: 使用 enable_thinking 开关
                requestBody.enable_thinking = !!thinkingMode;
                console.log(` Kimi K2.6 enable_thinking=${requestBody.enable_thinking} (${thinkingMode ? '深度模式' : '快速模式'})`);
            } else {
                // Moonshot 原生兼容写法
                requestBody.thinking = { type: thinkingMode ? 'enabled' : 'disabled' };
                console.log(` Kimi K2.6 thinking=${requestBody.thinking.type} (${thinkingMode ? '深度模式' : '快速模式'})`);
            }
        } else if (isQwen36A3BModel) {
            requestBody.enable_thinking = false;
            requestBody.thinking = { type: 'disabled' };
            console.log(' Qwen 3.6 多模态路径已关闭 thinking，避免正文为空和额外成本');
        } else {
            requestBody.temperature = parseFloat(temperature) || 0.7;
            requestBody.top_p = parseFloat(top_p) || 0.9;

            const modelThinkingBudget = resolveThinkingBudgetForModel(actualModel, !!thinkingMode, thinkingBudget);
            if (modelThinkingBudget !== null) {
                requestBody.thinking_budget = modelThinkingBudget;
                console.log(` ${actualModel} thinking_budget=${modelThinkingBudget} (${thinkingMode ? '思考模式' : '快速模式'})`);
            }
        }

        //  流式工具调用：为请求添加 tools 参数
        if (useStreamingTools) {
            requestBody.tools = runtimeToolDefinitions;
            // 支持“先说一部分，再按需调用工具，再继续说”
            requestBody.tool_choice = "auto";
            console.log(` 已为流式调用添加工具定义: ${runtimeToolDefinitions.length}个工具`);
        }

        //  防御性检查：确保数值解析成功
        if (Object.prototype.hasOwnProperty.call(requestBody, 'temperature') &&
            (isNaN(requestBody.temperature) || requestBody.temperature < 0 || requestBody.temperature > 2)) {
            console.warn(` 无效的temperature值: ${temperature}，使用默认值0.7`);
            requestBody.temperature = 0.7;
        }
        if (Object.prototype.hasOwnProperty.call(requestBody, 'top_p') &&
            (isNaN(requestBody.top_p) || requestBody.top_p < 0 || requestBody.top_p > 1)) {
            console.warn(` 无效的top_p值: ${top_p}，使用默认值0.9`);
            requestBody.top_p = 0.9;
        }
        if (isNaN(requestBody.max_tokens) || requestBody.max_tokens < 100 || requestBody.max_tokens > 8000) {
            console.warn(` 无效的max_tokens值: ${max_tokens}，使用默认值2000`);
            requestBody.max_tokens = 2000;
        }

        // 阿里云兼容思考模式（旧模型兼容）
        if (thinkingMode && routing.provider === 'aliyun') {
            requestBody.enable_thinking = true;

            //  思考预算直接放顶层，不用extra_body
            const budget = parseInt(thinkingBudget);
            const validBudget = Math.max(256, Math.min(isNaN(budget) ? 1024 : budget, 32768));

            requestBody.thinking_budget = validBudget;  //  改为直接放顶层

            console.log(` 阿里云思考模式已开启, 预算: ${validBudget} tokens`);
        }

        // 阿里云互联网模式
        if (internetMode && routing.provider === 'aliyun') {
            //  修复：确保enable_search是布尔值，不能是其他类型
            requestBody.enable_search = true;
            // 新增：启用搜索来源和角标功能
            requestBody.search_options = {
                enable_source: true,        // 返回搜索来源列表
                enable_citation: true,      // 在回答中插入角标
                citation_format: "[<number>]"  // 角标格式: [1], [2]
            };
            console.log(` 阿里云互联网搜索已开启（启Enable角标引用）`);
        }

        // DeepSeek参数
        if (routing.provider === 'deepseek') {
            applyDeepSeekV4ModeParams(requestBody, !!thinkingMode, normalizedReasoningProfile);

            if (!thinkingMode) {
                //  确保frequency_penalty和presence_penalty是有效的数值
                const freqPenalty = parseFloat(frequency_penalty);
                const presPenalty = parseFloat(presence_penalty);

                requestBody.frequency_penalty = (isNaN(freqPenalty) ? 0 : Math.max(0, Math.min(freqPenalty, 2)));
                requestBody.presence_penalty = (isNaN(presPenalty) ? 0 : Math.max(0, Math.min(presPenalty, 2)));

                console.log(` DeepSeek非思考模式: thinking=disabled, frequency_penalty=${requestBody.frequency_penalty}, presence_penalty=${requestBody.presence_penalty}`);
            } else {
                console.log(` DeepSeek思考模式: thinking=enabled, reasoning_effort=${requestBody.reasoning_effort}`);
            }
        }

        if (routing.provider === 'newapi') {
            applyNewApiModelParams(requestBody, actualModel, !!thinkingMode, normalizedReasoningProfile);
            if (requestBody.reasoning_effort) {
                console.log(` NewAPI ${actualModel} reasoning_effort=${requestBody.reasoning_effort}`);
            }
        }

        if (routing.provider === 'openrouter') {
            applyOpenRouterReasoningParams(requestBody, actualModel, !!thinkingMode, normalizedReasoningProfile);
            if (requestBody.reasoning) {
                console.log(` OpenRouter ${actualModel} reasoning=${JSON.stringify(requestBody.reasoning)}`);
            }
        }

        console.log(` 请求体摘要: messages=${requestBody.messages?.length || 0}, tools=${requestBody.tools?.length || 0}, stream=${!!requestBody.stream}`);

        //  加强过滤：将autoRoutingReason转换为可以放入HTTP头的格式（移除所有中文和特殊字符）
        const reasonForHeader = (autoRoutingReason || '')
            .replace(/[\u4e00-\u9fa5\u3000-\u303F\uFF00-\uFFEF]/g, '')  // 移除所有中日韩字符
            .replace(/[^\x20-\x7E]/g, '')      // 只保留可打印ASCII字符
            .replace(/[\r\n\t]/g, ' ')         // 替换换行符为空格
            .trim()
            .substring(0, 100);

        //  验证请求体的关键字段
        if (!requestBody.model) {
            console.error(' 请求体缺少model字段');
            res.write(`data: ${JSON.stringify({ type: 'error', error: '模型配置错误' })}\n\n`);
            res.end();
            db.run('DELETE FROM active_requests WHERE id = ?', [requestId]);
            return;
        }

        if (!Array.isArray(requestBody.messages) || requestBody.messages.length === 0) {
            console.error(' 请求体消息为空');
            res.write(`data: ${JSON.stringify({ type: 'error', error: '消息不能为空' })}\n\n`);
            res.end();
            db.run('DELETE FROM active_requests WHERE id = ?', [requestId]);
            return;
        }

        // 注意：SSE头已在搜索前提前设置（约第1770行）
        // 新增：如果有搜索来源，立即发送给前端
        if (searchSources && searchSources.length > 0) {
            res.write(`data: ${JSON.stringify({ type: 'sources', sources: searchSources })}\n\n`);
            console.log(` 已发送 ${searchSources.length} 个搜索来源到前端`);
        }

        console.log(`\n 发送请求到 ${routing.provider} - ${actualModel}\n`);

        //  关键修复：调用API
        console.log(` 正在调用: ${providerConfig.baseURL}`);
        console.log(`   API密钥: 已配置`);

        //  修复：添加超时控制 (120秒) - 增加超时时间以应对网络不稳定
        const controller = new AbortController();
        let timeoutId = setTimeout(() => controller.abort(), 120000);

        //  关键修复：将变量声明移到try块外部，避免作用域问题
        let fullContent = '';
        let reasoningContent = '';
        let rawToolContent = '';
        let agentSynthesizerRunning = false;
        let agentResearcherRunning = false;
        let rawAssistantStructuredBuffer = '';
        let assistantVisibleStarted = false;
        let latestStructuredAssistantOutput = {
            visibleContent: '',
            extractedTitle: null,
            canvasPatch: null,
            canvasPatchRaw: '',
            canvasPatchParseError: null
        };

        const emitStructuredAssistantChunk = (rawChunk = '') => {
            const normalizedChunk = typeof rawChunk === 'string' ? rawChunk : String(rawChunk || '');
            if (!normalizedChunk) return '';

            rawAssistantStructuredBuffer += normalizedChunk;
            latestStructuredAssistantOutput = parseStructuredAssistantOutput(rawAssistantStructuredBuffer);
            const nextVisibleContent = sanitizeAssistantVisibleContent(latestStructuredAssistantOutput.visibleContent || '');
            if (!assistantVisibleStarted && shouldHoldAssistantVisibleContent(rawAssistantStructuredBuffer, nextVisibleContent)) {
                return '';
            }

            const visibleDelta = nextVisibleContent.startsWith(fullContent)
                ? nextVisibleContent.slice(fullContent.length)
                : nextVisibleContent;

            fullContent = nextVisibleContent;

            if (visibleDelta) {
                assistantVisibleStarted = true;
                if (liveStreamState) {
                    liveStreamState.assistantContent += visibleDelta;
                    liveStreamState.updatedAt = Date.now();
                    persistSessionStreamDraft(liveStreamState, false);
                    broadcastSessionStreamState(liveStreamState, 'session_stream_delta');
                }
                res.write(`data: ${JSON.stringify({ type: 'content', content: visibleDelta })}\n\n`);
            }

            return visibleDelta;
        };

        if (enableResearchDebate) {
            clearTimeout(timeoutId);
                const researchTraceState = {
                    version: 1,
                    mode: 'research_debate',
                    researchMode: normalizedResearchMode,
                    requestedMaxRounds: normalizedResearchMaxRounds,
                    plan: null,
                    tasks: {},
                    statuses: [],
                    drafts: [],
                    draftDeltas: [],
                    agentEvents: [],
                    metrics: null,
                    trace: [],
                    discussion: null,
                    savedAt: null
                };
                const recordResearchTraceEvent = (payload) => {
                    const event = payload && typeof payload === 'object' ? payload : null;
                    if (!event || !event.type) return;
                    const eventTs = Date.now();
                    const compactEvent = {
                        ...event,
                        delta: event.delta ? truncateResearchText(event.delta, 1200) : event.delta,
                        reasoningDelta: event.reasoningDelta ? truncateResearchText(event.reasoningDelta, 1200) : event.reasoningDelta,
                        rawContent: event.rawContent ? truncateResearchText(event.rawContent, 3000) : event.rawContent,
                        reasoningContent: event.reasoningContent ? truncateResearchText(event.reasoningContent, 3000) : event.reasoningContent,
                        ts: eventTs
                    };
                    researchTraceState.agentEvents.push(compactEvent);
                    if (researchTraceState.agentEvents.length > 600) {
                        researchTraceState.agentEvents = researchTraceState.agentEvents.slice(-600);
                    }
                    const traceText = event.detail || event.summary || event.task || event.mode || '';
                    researchTraceState.trace.push({
                        kind: event.type,
                        text: String(traceText || '').slice(0, 240),
                        ts: eventTs
                    });
                    if (researchTraceState.trace.length > 300) {
                        researchTraceState.trace = researchTraceState.trace.slice(-300);
                    }

                if (event.type === 'agent_plan') {
                    researchTraceState.plan = event;
                    if (Array.isArray(event.tasks)) {
                        for (const task of event.tasks) {
                            const taskId = Number(task.agent_id || task.taskId || 0);
                            if (!taskId) continue;
                            const stepId = task.role === 'master' ? 'research-master' : `research-${task.role || taskId}`;
                            researchTraceState.tasks[stepId] = {
                                stepId,
                                taskId,
                                role: task.role || 'researcher',
                                status: 'pending',
                                detail: task.task || '',
                                durationMs: null
                            };
                        }
                    }
                    return;
                }

                if (event.type === 'agent_status') {
                    const stepId = event.stepId || (event.role === 'master' ? 'research-master' : `research-${event.role || 'agent'}`);
                    const statusEvent = {
                        type: event.type,
                        scope: event.scope || 'stage',
                        stepId,
                        taskId: event.taskId || null,
                        role: event.role || 'agent',
                        status: event.status || 'pending',
                        detail: event.detail || '',
                        durationMs: event.durationMs || null,
                        ts: Date.now()
                    };
                    researchTraceState.statuses.push(statusEvent);
                    if (researchTraceState.statuses.length > 300) {
                        researchTraceState.statuses = researchTraceState.statuses.slice(-300);
                    }
                    const previous = researchTraceState.tasks[stepId] || {};
                    researchTraceState.tasks[stepId] = {
                        ...previous,
                        stepId,
                        taskId: event.taskId || previous.taskId || null,
                        role: event.role || previous.role || 'agent',
                        status: event.status || previous.status || 'pending',
                        detail: event.detail || previous.detail || '',
                        durationMs: event.durationMs != null ? event.durationMs : (previous.durationMs || null)
                    };
                    return;
                }

                if (event.type === 'agent_draft') {
                    researchTraceState.drafts.push(event);
                    if (researchTraceState.drafts.length > 16) {
                        researchTraceState.drafts = researchTraceState.drafts.slice(-16);
                    }
                    return;
                }

                if (event.type === 'agent_draft_delta') {
                    researchTraceState.draftDeltas.push({
                        type: event.type,
                        taskId: event.taskId || null,
                        stepId: event.stepId || '',
                        role: event.role || 'agent',
                        task: event.task || '',
                        round: event.round || event.debateRound || null,
                        speech: event.speech === true,
                        reset: event.reset === true,
                        delta: event.delta ? truncateResearchText(event.delta, 1200) : '',
                        reasoningDelta: event.reasoningDelta ? truncateResearchText(event.reasoningDelta, 1200) : '',
                        ts: eventTs
                    });
                    if (researchTraceState.draftDeltas.length > 800) {
                        researchTraceState.draftDeltas = researchTraceState.draftDeltas.slice(-800);
                    }
                    return;
                }

                if (event.type === 'agent_metrics') {
                    researchTraceState.metrics = event;
                }
            };

            try {
                console.log(`\n 启用${normalizedResearchMode === 'deep' ? '深度研究' : '快速研究'}讨论模式 (${normalizedResearchAgentModels.map(researchModelLabel).join(' + ')})\n`);
                const researchResult = await runResearchDebateMode({
                    res,
                    requestId,
                    messages: finalMessages,
                    userMessage: userContent,
                    masterModelId: finalModel,
                    agentModelIds: normalizedResearchAgentModels,
                    researchMode: normalizedResearchMode,
                    debateThinkingMode: normalizedResearchMode === 'deep',
                    maxDebateRounds: normalizedResearchMaxRounds,
                    reasoningProfile: normalizedReasoningProfile,
                    maxTokens: max_tokens,
                    onContent: emitStructuredAssistantChunk,
                    onReasoning: (chunk) => {
                        if (!chunk) return;
                        reasoningContent += chunk;
                        res.write(`data: ${JSON.stringify({ type: 'reasoning', content: chunk })}\n\n`);
                    },
                    onAgentEvent: recordResearchTraceEvent
                });

                finalModel = researchResult.finalModel || finalModel;
                actualModel = researchResult.actualModel || actualModel;
                routing = MODEL_ROUTING[finalModel] || routing;
                if (routing?.provider && API_PROVIDERS[routing.provider]) {
                    providerConfig = API_PROVIDERS[routing.provider];
                }

                if (sessionId) {
                    console.log('\n 保存深度研究结果到数据库');

                    const lastUserMessage = messages[messages.length - 1];
                    if (lastUserMessage && lastUserMessage.role === 'user') {
                        const lastUserContent = typeof lastUserMessage.content === 'string'
                            ? stripInlinePromptTimeHint(lastUserMessage.content)
                            : JSON.stringify(lastUserMessage.content);

                        let attachmentsJson = null;
                        if (Array.isArray(lastUserMessage.attachments) && lastUserMessage.attachments.length > 0) {
                            const previewAttachments = lastUserMessage.attachments.map(att => {
                                if (att.type === 'image' && att.data) {
                                    return {
                                        type: 'image',
                                        fileName: att.fileName,
                                        data: att.data
                                    };
                                }
                                return {
                                    type: att.type,
                                    fileName: att.fileName
                                };
                            });
                            attachmentsJson = JSON.stringify(previewAttachments);
                        }

                        await dbRunAsync(
                            'INSERT INTO messages (session_id, role, content, attachments, created_at) VALUES (?, ?, ?, ?, ?)',
                            [sessionId, 'user', lastUserContent, attachmentsJson, new Date().toISOString()]
                        );
                    }

                    let contentToSave = fullContent || researchResult.content || (reasoningContent ? '(纯思考内容)' : '(生成中断)');
                    contentToSave = contentToSave
                        .replace(/<\|[^|]+\|>/g, '')
                        .replace(/functions\.\w+:\d+/g, '')
                        .trim();
                    const structuredResearchOutput = parseStructuredAssistantOutput(rawAssistantStructuredBuffer || contentToSave);
                    const extractedTitle = structuredResearchOutput.extractedTitle || null;
                    contentToSave = (structuredResearchOutput.visibleContent || contentToSave).trim();
                    if (!contentToSave) {
                        contentToSave = reasoningContent ? '(纯思考内容)' : '(生成中断)';
                    }

                    researchTraceState.savedAt = new Date().toISOString();
                    researchTraceState.drafts.push({
                        taskId: 999,
                        role: 'master',
                        task: '深度研究最终回答',
                        summary: contentToSave.replace(/\s+/g, ' ').slice(0, 120),
                        content: truncateResearchText(contentToSave, 8000)
                    });
                    researchTraceState.discussion = {
                        mode: researchResult.trace?.stopRule ? 'research_chat_debate' : 'research_debate',
                        researchMode: normalizedResearchMode,
                        rounds: Array.isArray(researchResult.trace?.debateRounds) ? researchResult.trace.debateRounds : [],
                        speeches: Array.isArray(researchResult.trace?.critiqueResults) ? researchResult.trace.critiqueResults : [],
                        initialResults: Array.isArray(researchResult.trace?.initialResults) ? researchResult.trace.initialResults : [],
                        userInterjections: Array.isArray(researchResult.trace?.userInterjections) ? researchResult.trace.userInterjections : [],
                        consensusReached: researchResult.trace?.consensusReached === true,
                        masterDecisionReason: researchResult.trace?.masterDecisionReason || '',
                        master: researchResult.trace?.master || null
                    };
                    const processTraceJson = JSON.stringify({
                        version: researchTraceState.version,
                        mode: researchTraceState.mode,
                        researchMode: researchTraceState.researchMode,
                        discussionRounds: researchTraceState.discussion.rounds.length,
                        consensusReached: researchTraceState.discussion.consensusReached,
                        plan: researchTraceState.plan,
                        tasks: Object.values(researchTraceState.tasks || {}).sort((a, b) => Number(a.taskId || 0) - Number(b.taskId || 0)),
                        statuses: researchTraceState.statuses,
                        drafts: researchTraceState.drafts,
                        metrics: researchTraceState.metrics,
                        discussion: researchTraceState.discussion,
                        agentEvents: researchTraceState.agentEvents,
                        draftDeltas: researchTraceState.draftDeltas,
                        trace: researchTraceState.trace,
                        savedAt: researchTraceState.savedAt,
                        prompt_context: promptContextTrace?.prompt_context || null
                    });

                    await dbRunAsync(
                        'INSERT INTO messages (session_id, role, content, reasoning_content, model, enable_search, thinking_mode, internet_mode, sources, process_trace, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                        [
                            sessionId,
                            'assistant',
                            contentToSave,
                            (reasoningContent || researchResult.reasoningContent || '').trim() || null,
                            finalModel,
                            internetMode ? 1 : 0,
                            normalizedResearchMode === 'deep' ? 1 : 0,
                            internetMode ? 1 : 0,
                            searchSources && searchSources.length > 0 ? JSON.stringify(searchSources) : null,
                            processTraceJson,
                            new Date().toISOString()
                        ]
                    );

                    if (extractedTitle) {
                        if (flowId) {
                            await syncFlowTitle(flowId, req.user.userId, extractedTitle);
                        } else {
                            await dbRunAsync(
                                'UPDATE sessions SET title = ? WHERE id = ?',
                                [extractedTitle, sessionId]
                            );
                        }
                        res.write(`data: ${JSON.stringify({ type: 'title', title: extractedTitle })}\n\n`);
                    }

                    if (flowId && structuredResearchOutput.canvasPatchRaw) {
                        res.write(`data: ${JSON.stringify({
                            type: 'canvas_patch',
                            patch: structuredResearchOutput.canvasPatch,
                            raw: structuredResearchOutput.canvasPatchRaw,
                            valid: !structuredResearchOutput.canvasPatchParseError,
                            error: structuredResearchOutput.canvasPatchParseError || null
                        })}\n\n`);
                    }

                    await dbRunAsync(
                        'UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                        [sessionId]
                    );

                    if (!memoryModeOff && !flowId) {
                        scheduleConversationMemoryProcessing({
                            userId: req.user.userId,
                            sessionId,
                            userContent,
                            assistantContent: contentToSave || ''
                        });
                    }
                }

                res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
                res.end();
                console.log(`\n ${normalizedResearchMode === 'deep' ? '深度研究' : '快速研究'}讨论处理完成\n`);
                return;
            } catch (researchError) {
                console.error(' 研究讨论失败:', researchError.message);
                emitAgentEvent(res, {
                    type: 'agent_status',
                    role: 'master',
                    scope: 'stage',
                    stepId: 'research-master',
                    status: 'failed',
                    detail: '研究讨论异常，已回退单模型流程'
                });
                enableResearchDebate = false;
                if (String(fullContent || '').trim()) {
                    res.write(`data: ${JSON.stringify({ type: 'error', error: `研究模式中断: ${researchError.message}` })}\n\n`);
                    res.end();
                    return;
                }
                timeoutId = setTimeout(() => controller.abort(), 120000);
            }
        }

        //  Gemini API 特殊处理
        let isGeminiAPI = providerConfig.isGemini || routing.isGemini;
        const shouldEnableToolsForRoute = (candidateRouting) => !!(
            runtimeToolDefinitions.length > 0 &&
            candidateRouting?.provider !== 'aliyun' &&
            (candidateRouting?.supportsWebSearch !== false || imageGenerationRequested || memoryDeleteToolRequested)
        );

        const buildRuntimeFallbackRequestBody = (fallbackModelId, fallbackRouting, fallbackActualModel) => {
            if (fallbackRouting.provider === 'siliconflow') {
                const siliconflowBody = buildSiliconflowFreeFallbackRequestBody({
                    actualModel: fallbackActualModel,
                    messages: finalMessages,
                    internetMode: false,
                    thinkingMode,
                    thinkingBudget,
                    temperature,
                    top_p,
                    max_tokens
                });
                if (shouldEnableToolsForRoute(fallbackRouting)) {
                    siliconflowBody.tools = runtimeToolDefinitions;
                    siliconflowBody.tool_choice = 'auto';
                }
                return siliconflowBody;
            }

            const body = {
                model: fallbackActualModel,
                messages: finalMessages,
                max_tokens: parseInt(max_tokens, 10) || 2000,
                stream: true,
                temperature: parseFloat(temperature) || 0.7,
                top_p: parseFloat(top_p) || 0.9
            };

            if (
                fallbackRouting.provider === 'openrouter' &&
                Array.isArray(fallbackRouting.fallbackModels) &&
                fallbackRouting.fallbackModels.length > 1
            ) {
                body.models = fallbackRouting.fallbackModels;
            }

            if (fallbackRouting.provider === 'openrouter') {
                applyOpenRouterReasoningParams(body, fallbackActualModel, !!thinkingMode, normalizedReasoningProfile);
            }

            if (fallbackModelId === 'qwen3.6-35b-a3b' || isQwen36A3BActualModel(fallbackActualModel)) {
                body.enable_thinking = false;
                body.thinking = { type: 'disabled' };
                delete body.reasoning_effort;
                delete body.reasoning;
            }

            if (shouldEnableToolsForRoute(fallbackRouting)) {
                body.tools = runtimeToolDefinitions;
                body.tool_choice = 'auto';
            }

            return body;
        };

        const buildFetchPayloadForAttempt = (attemptProviderConfig, attemptRouting, attemptActualModel, attemptRequestBody) => {
            const attemptIsGeminiAPI = attemptProviderConfig.isGemini || attemptRouting.isGemini;
            if (!attemptIsGeminiAPI) {
                return {
                    isGeminiAPI: false,
                    apiUrl: attemptProviderConfig.baseURL,
                    fetchHeaders: buildProviderFetchHeaders(attemptProviderConfig, attemptRouting.provider),
                    fetchBody: attemptRequestBody
                };
            }

            const geminiContents = [];
            for (const msg of finalMessages) {
                if (msg.role === 'system') continue;
                const geminiRole = msg.role === 'assistant' ? 'model' : 'user';
                const parts = [];

                if (Array.isArray(msg.content)) {
                    for (const item of msg.content) {
                        if (item.type === 'text') {
                            parts.push({ text: item.text });
                        } else if (item.type === 'image_url' && item.image_url?.url) {
                            const imageUrl = item.image_url.url;
                            if (imageUrl.startsWith('data:')) {
                                const matches = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
                                if (matches) {
                                    parts.push({
                                        inlineData: {
                                            mimeType: matches[1],
                                            data: matches[2]
                                        }
                                    });
                                }
                            } else {
                                parts.push({ fileData: { fileUri: imageUrl, mimeType: 'image/jpeg' } });
                            }
                        }
                    }
                } else {
                    parts.push({ text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) });
                }

                if (msg.attachments && Array.isArray(msg.attachments)) {
                    for (const att of msg.attachments) {
                        if (att.type === 'image' && att.data) {
                            const imageData = att.data;
                            if (imageData.startsWith('data:')) {
                                const matches = imageData.match(/^data:([^;]+);base64,(.+)$/);
                                if (matches) {
                                    parts.push({
                                        inlineData: {
                                            mimeType: matches[1],
                                            data: matches[2]
                                        }
                                    });
                                }
                            }
                        }
                    }
                }

                geminiContents.push({ role: geminiRole, parts });
            }

            const fetchBody = {
                contents: geminiContents,
                generationConfig: {
                    temperature: parseFloat(temperature) || 0.7,
                    topP: parseFloat(top_p) || 0.9,
                    maxOutputTokens: Math.min(parseInt(max_tokens, 10) || 2000, attemptRouting.maxOutputTokens || 8000)
                }
            };

            const systemMsg = finalMessages.find(m => m.role === 'system');
            if (systemMsg) {
                fetchBody.systemInstruction = {
                    parts: [{ text: typeof systemMsg.content === 'string' ? systemMsg.content : JSON.stringify(systemMsg.content) }]
                };
            }

            return {
                isGeminiAPI: true,
                apiUrl: `${attemptProviderConfig.baseURL}/${attemptActualModel}:streamGenerateContent?key=${attemptProviderConfig.apiKey}&alt=sse`,
                fetchHeaders: {
                    'Content-Type': 'application/json'
                },
                fetchBody
            };
        };

        const tryUniversalRuntimeFallback = async ({ failedStatus, failedBody, reason }) => {
            const candidates = getRuntimeFallbackModelIds(finalModel, { requiresMultimodal: isMultimodalRequest });
            appendRaiRuntimeReport({
                level: '报错',
                tag: 'model_api_primary_failed',
                message: reason || 'primary model API failed, starting ordered fallback',
                context: {
                    sessionId,
                    requestId,
                    finalModel,
                    actualModel,
                    provider: routing?.provider,
                    failedStatus,
                    failedBody
                }
            });
            for (const fallbackModel of candidates) {
                const fallbackRouting = MODEL_ROUTING[fallbackModel];
                const fallbackProviderConfig = fallbackRouting ? API_PROVIDERS[fallbackRouting.provider] : null;
                if (!fallbackRouting || !fallbackProviderConfig?.apiKey) {
                    const missingEnv = fallbackProviderConfig?.envKey || fallbackRouting?.provider || fallbackModel;
                    console.warn(` runtime_fallback skip=${fallbackModel} missing=${missingEnv}`);
                    continue;
                }

                const fallbackActualModel = fallbackRouting.model;
                const fallbackUseStreamingTools = shouldEnableToolsForRoute(fallbackRouting);
                const fallbackRequestBody = buildRuntimeFallbackRequestBody(fallbackModel, fallbackRouting, fallbackActualModel);
                const payload = buildFetchPayloadForAttempt(
                    fallbackProviderConfig,
                    fallbackRouting,
                    fallbackActualModel,
                    fallbackRequestBody
                );

                const fallbackController = new AbortController();
                const fallbackTimeoutId = setTimeout(() => fallbackController.abort(), 120000);
                let fallbackResponse;
                try {
                    const safeFallbackUrl = payload.isGeminiAPI
                        ? payload.apiUrl.replace(/key=[^&]+/, 'key=***')
                        : payload.apiUrl;
                    console.warn(` runtime_fallback try=${fallbackModel} provider=${fallbackRouting.provider} url=${safeFallbackUrl}`);
                    fallbackResponse = await fetch(payload.apiUrl, {
                        method: 'POST',
                        headers: payload.fetchHeaders,
                        body: JSON.stringify(payload.fetchBody),
                        signal: fallbackController.signal
                    });
                } catch (fallbackErr) {
                    clearTimeout(fallbackTimeoutId);
                    console.warn(` runtime_fallback network_failed model=${fallbackModel} error=${fallbackErr.message}`);
                    appendRaiRuntimeReport({
                        level: '报错',
                        tag: 'model_api_fallback_network_failed',
                        message: fallbackErr.message,
                        context: {
                            sessionId,
                            requestId,
                            fallbackModel,
                            provider: fallbackRouting.provider,
                            reason
                        }
                    });
                    continue;
                }
                clearTimeout(fallbackTimeoutId);

                if (!fallbackResponse.ok) {
                    const fallbackErrorText = await fallbackResponse.text();
                    console.warn(` runtime_fallback failed model=${fallbackModel} status=${fallbackResponse.status} body=${fallbackErrorText.substring(0, 220)}`);
                    appendRaiRuntimeReport({
                        level: '报错',
                        tag: 'model_api_fallback_http_failed',
                        message: `fallback ${fallbackModel} failed with HTTP ${fallbackResponse.status}`,
                        context: {
                            sessionId,
                            requestId,
                            fallbackModel,
                            provider: fallbackRouting.provider,
                            status: fallbackResponse.status,
                            body: fallbackErrorText,
                            reason
                        }
                    });
                    continue;
                }

                routing = fallbackRouting;
                providerConfig = fallbackProviderConfig;
                finalModel = fallbackModel;
                actualModel = fallbackActualModel;
                requestBody = fallbackRequestBody;
                useStreamingTools = fallbackUseStreamingTools;
                isGeminiAPI = payload.isGeminiAPI;

                const fallbackReason = reason || `primary_failed_${failedStatus || 'network'}`;
                res.write(`data: ${JSON.stringify({
                    type: 'model_info',
                    model: finalModel,
                    actualModel,
                    reason: `runtime_fallback:${fallbackReason}`,
                    provider: routing.provider
                })}\n\n`);
                console.warn(` runtime_fallback success model=${fallbackModel} actual=${actualModel} from_status=${failedStatus || 'network'} body=${String(failedBody || '').substring(0, 160)}`);
                appendRaiRuntimeReport({
                    level: '恢复',
                    tag: 'model_api_fallback_success',
                    message: `fallback succeeded with ${fallbackModel}`,
                    context: {
                        sessionId,
                        requestId,
                        fallbackModel,
                        provider: routing.provider,
                        reason: fallbackReason
                    }
                });
                return { response: fallbackResponse, errorText: '' };
            }

            appendRaiRuntimeReport({
                level: '报错',
                tag: 'model_api_all_fallback_failed',
                message: 'all ordered fallback models failed or were unavailable',
                context: {
                    sessionId,
                    requestId,
                    originalModel: finalModel,
                    provider: routing?.provider,
                    candidates,
                    failedStatus,
                    failedBody,
                    reason
                }
            });
            return null;
        };

        const sendFinalApiFailure = (tag, message, context = {}) => {
            appendRaiRuntimeReport({
                level: '报错',
                tag,
                message,
                context: {
                    sessionId,
                    requestId,
                    finalModel,
                    actualModel,
                    provider: routing?.provider,
                    ...context
                }
            });
            res.write(`data: ${JSON.stringify({ type: 'error', error: buildUserFacingApiFailureMessage() })}\n\n`);
            res.end();
            db.run('DELETE FROM active_requests WHERE id = ?', [requestId]);
        };

        try {
            let apiUrl, fetchHeaders, fetchBody;

            if (isGeminiAPI) {
                // ============ Gemini API 格式 ============
                // Gemini endpoint: {baseURL}/{modelName}:streamGenerateContent?key=API_KEY&alt=sse
                apiUrl = `${providerConfig.baseURL}/${actualModel}:streamGenerateContent?key=${providerConfig.apiKey}&alt=sse`;

                // Gemini 请求头
                fetchHeaders = {
                    'Content-Type': 'application/json'
                };

                // 将 OpenAI 格式的 messages 转换为 Gemini 格式的 contents
                const geminiContents = [];
                for (const msg of finalMessages) {
                    if (msg.role === 'system') {
                        // Gemini 将 system 作为 systemInstruction 处理
                        continue; // 我们在下面单独处理
                    }
                    const geminiRole = msg.role === 'assistant' ? 'model' : 'user';

                    // 处理多模态内容（图片）
                    const parts = [];
                    if (Array.isArray(msg.content)) {
                        // OpenAI多模态格式: [{type: 'text', text: '...'}, {type: 'image_url', image_url: {url: '...'}}]
                        for (const item of msg.content) {
                            if (item.type === 'text') {
                                parts.push({ text: item.text });
                            } else if (item.type === 'image_url' && item.image_url?.url) {
                                // 处理base64图片 (data:image/...;base64,...)
                                const imageUrl = item.image_url.url;
                                if (imageUrl.startsWith('data:')) {
                                    const matches = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
                                    if (matches) {
                                        parts.push({
                                            inlineData: {
                                                mimeType: matches[1],
                                                data: matches[2]
                                            }
                                        });
                                    }
                                } else {
                                    // 外部URL图片
                                    parts.push({ fileData: { fileUri: imageUrl, mimeType: 'image/jpeg' } });
                                }
                            }
                        }
                    } else {
                        // 纯文本消息
                        parts.push({ text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) });
                    }

                    // 处理附件（如果有）
                    if (msg.attachments && Array.isArray(msg.attachments)) {
                        for (const att of msg.attachments) {
                            if (att.type === 'image' && att.data) {
                                // Base64图片附件
                                const imageData = att.data;
                                if (imageData.startsWith('data:')) {
                                    const matches = imageData.match(/^data:([^;]+);base64,(.+)$/);
                                    if (matches) {
                                        parts.push({
                                            inlineData: {
                                                mimeType: matches[1],
                                                data: matches[2]
                                            }
                                        });
                                    }
                                }
                            }
                        }
                    }

                    geminiContents.push({ role: geminiRole, parts });
                }

                // 提取 system prompt
                const systemMsg = finalMessages.find(m => m.role === 'system');

                fetchBody = {
                    contents: geminiContents,
                    generationConfig: {
                        temperature: parseFloat(temperature) || 0.7,
                        topP: parseFloat(top_p) || 0.9,
                        maxOutputTokens: Math.min(parseInt(max_tokens, 10) || 2000, routing.maxOutputTokens || 8000)
                    }
                };

                // 如果有 system prompt，添加为 systemInstruction
                if (systemMsg) {
                    fetchBody.systemInstruction = {
                        parts: [{ text: typeof systemMsg.content === 'string' ? systemMsg.content : JSON.stringify(systemMsg.content) }]
                    };
                }

                const safeGeminiApiUrl = apiUrl.replace(/key=[^&]+/, 'key=***');
                console.log(` Gemini API 请求: ${safeGeminiApiUrl}`);
                console.log(`   模型: ${actualModel}`);
                console.log(`   消息数: ${geminiContents.length}`);
            } else {
                // ============ OpenAI 兼容 API 格式 ============
                apiUrl = providerConfig.baseURL;
                fetchHeaders = {
                    'Authorization': `Bearer ${providerConfig.apiKey}`,
                    'Content-Type': 'application/json'
                };
                fetchBody = requestBody;
            }

            const safeApiUrl = isGeminiAPI ? apiUrl.replace(/key=[^&]+/, 'key=***') : apiUrl;
            console.log(` 正在调用: ${safeApiUrl}`);
            console.log(`   API密钥: 已配置`);

            let apiResponse;
            try {
                apiResponse = await fetch(apiUrl, {
                    method: 'POST',
                    headers: fetchHeaders,
                    body: JSON.stringify(fetchBody),
                    signal: controller.signal
                });
                clearTimeout(timeoutId); // 清除超时定时器
            } catch (primaryFetchError) {
                clearTimeout(timeoutId);
                const fallbackResult = await tryUniversalRuntimeFallback({
                    failedStatus: primaryFetchError.name === 'AbortError' ? 'timeout' : 'network',
                    failedBody: primaryFetchError.message,
                    reason: `${routing.provider}_${actualModel}_${primaryFetchError.name === 'AbortError' ? 'timeout' : 'network_error'}`
                });
                if (fallbackResult?.response) {
                    apiResponse = fallbackResult.response;
                } else {
                    throw primaryFetchError;
                }
            }

            console.log(` API响应状态: ${apiResponse.status} ${apiResponse.statusText}`);

            //  修复错误处理
            if (!apiResponse.ok) {
                let errorText = await apiResponse.text();
                console.error(` API返回错误:`);
                console.error(`   状态码: ${apiResponse.status}`);
                console.error(`   响应体: ${errorText.substring(0, 500)}`);

                if (!apiResponse.ok) {
                    const fallbackResult = await tryUniversalRuntimeFallback({
                        failedStatus: apiResponse.status,
                        failedBody: errorText,
                        reason: `${routing.provider}_${actualModel}_failed`
                    });
                    if (fallbackResult?.response) {
                        apiResponse = fallbackResult.response;
                        errorText = fallbackResult.errorText || '';
                    }
                }

                if (!apiResponse.ok) {
                    if (isGeminiAPI && finalModel === 'gemma') {
                        const fallbackProviderConfig = API_PROVIDERS.openrouter;
                        if (fallbackProviderConfig?.apiKey) {
                            console.warn(` Gemma Google API unavailable, fallback to OpenRouter free route: status=${apiResponse.status}`);
                            routing = {
                                provider: 'openrouter',
                                model: 'openrouter/free',
                                fallbackModels: ['openrouter/free', 'openai/gpt-oss-120b:free'],
                                supportsThinking: true,
                                supportsWebSearch: false,
                                multimodal: false
                            };
                            providerConfig = fallbackProviderConfig;
                            actualModel = routing.model;
                            requestBody = {
                                model: actualModel,
                                models: routing.fallbackModels,
                                messages: finalMessages,
                                max_tokens: parseInt(max_tokens, 10) || 2000,
                                stream: true,
                                temperature: parseFloat(temperature) || 0.7,
                                top_p: parseFloat(top_p) || 0.9
                            };
                            applyOpenRouterReasoningParams(requestBody, actualModel, !!thinkingMode, normalizedReasoningProfile);

                            res.write(`data: ${JSON.stringify({
                                type: 'model_info',
                                model: finalModel,
                                actualModel,
                                reason: 'gemma_google_api_fallback',
                                provider: routing.provider
                            })}\n\n`);

                            try {
                                apiResponse = await fetch(providerConfig.baseURL, {
                                    method: 'POST',
                                    headers: buildProviderFetchHeaders(providerConfig, routing.provider),
                                    body: JSON.stringify(requestBody)
                                });
                            } catch (fallbackErr) {
                                sendFinalApiFailure('gemma_openrouter_fallback_network_failed', fallbackErr.message, {
                                    previousStatus: apiResponse.status,
                                    previousBody: errorText
                                });
                                return;
                            }

                            if (!apiResponse.ok) {
                                errorText = await apiResponse.text();
                                console.warn(` gemma_google_api_fallback failed status=${apiResponse.status} body=${errorText.substring(0, 200)}`);
                            } else {
                                console.log(` Gemma Google API fallback connected: ${actualModel}`);
                            }
                        }
                    }

                    if (!apiResponse.ok) {
                    // SiliconFlow/Kimi 余额不足时，自动回退到备用免费链，避免全站不可用
                    const canFallbackToAliyun =
                        isInsufficientBalanceError(apiResponse.status, errorText) &&
                        routing.provider === 'siliconflow';

                    if (canFallbackToAliyun) {
                        const fallbackModel = resolveFreeFallbackModelId(finalModel);
                        const fallbackRouting = MODEL_ROUTING[fallbackModel];
                        const fallbackProviderConfig = fallbackRouting ? API_PROVIDERS[fallbackRouting.provider] : null;

                        if (fallbackRouting && fallbackProviderConfig?.apiKey) {
                            console.warn(` 检测到硅基余额不足，自动回退到免费模型 ${fallbackModel}`);
                            routing = fallbackRouting;
                            providerConfig = fallbackProviderConfig;
                            finalModel = fallbackModel;
                            actualModel = fallbackRouting.model;
                            useStreamingTools = shouldEnableToolsForRoute(fallbackRouting);

                            requestBody = buildRuntimeFallbackRequestBody(fallbackModel, fallbackRouting, actualModel);
                            const fallbackPayload = buildFetchPayloadForAttempt(
                                fallbackProviderConfig,
                                fallbackRouting,
                                actualModel,
                                requestBody
                            );
                            isGeminiAPI = fallbackPayload.isGeminiAPI;

                            res.write(`data: ${JSON.stringify({
                                type: 'model_info',
                                model: finalModel,
                                actualModel,
                                reason: 'fallback_insufficient_balance',
                                provider: routing.provider
                            })}\n\n`);

                            const fallbackController = new AbortController();
                            const fallbackTimeoutId = setTimeout(() => fallbackController.abort(), 120000);
                            try {
                                apiResponse = await fetch(fallbackPayload.apiUrl, {
                                    method: 'POST',
                                    headers: fallbackPayload.fetchHeaders,
                                    body: JSON.stringify(fallbackPayload.fetchBody),
                                    signal: fallbackController.signal
                                });
                            } catch (fallbackErr) {
                                clearTimeout(fallbackTimeoutId);
                                sendFinalApiFailure('siliconflow_balance_fallback_network_failed', fallbackErr.message, {
                                    fallbackModel
                                });
                                return;
                            }
                            clearTimeout(fallbackTimeoutId);

                            if (!apiResponse.ok) {
                                const fallbackErrorText = await apiResponse.text();
                                console.error(` 备用模型也失败: ${apiResponse.status} ${fallbackErrorText.substring(0, 300)}`);
                                sendFinalApiFailure('siliconflow_balance_fallback_http_failed', `fallback failed with HTTP ${apiResponse.status}`, {
                                    fallbackModel,
                                    status: apiResponse.status,
                                    body: fallbackErrorText
                                });
                                return;
                            }

                            console.log(` 备用模型连接成功，继续流式输出: ${fallbackModel}`);
                        } else {
                            sendFinalApiFailure('siliconflow_balance_no_fallback_available', `HTTP ${apiResponse.status}`, {
                                status: apiResponse.status,
                                body: errorText
                            });
                            return;
                        }
                    } else {
                        sendFinalApiFailure('model_api_final_http_failed', `HTTP ${apiResponse.status}`, {
                            status: apiResponse.status,
                            body: errorText
                        });
                        return;
                    }
                    }
                }
            }

            console.log(' API连接成功，开始接收流式响应\n');

            const reader = apiResponse.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let buffer = '';

            //  流式工具调用：累积 tool_calls 数据
            let accumulatedToolCalls = [];  // 累积的工具调用
            let pendingToolCall = null;     // 当前正在累积的工具调用
            let streamFinishReason = null;  // 流结束原因
            let toolMarkerCarry = '';
            let inToolCallSection = false;
            const TOOL_CALL_SECTION_START = '<|tool_calls_section_begin|>';
            const TOOL_CALL_SECTION_END = '<|tool_calls_section_end|>';
            let thinkTagCarry = '';
            let inThinkSection = false;
            const THINK_SECTION_START = '<think>';
            const THINK_SECTION_END = '</think>';

            const sanitizeStreamingContent = (chunk = '') => {
                if (!useStreamingTools || !chunk) return chunk;

                let text = toolMarkerCarry + chunk;
                toolMarkerCarry = '';
                let visible = '';

                while (text.length > 0) {
                    if (inToolCallSection) {
                        const endIdx = text.indexOf(TOOL_CALL_SECTION_END);
                        if (endIdx === -1) {
                            const carryLen = Math.min(text.length, TOOL_CALL_SECTION_END.length - 1);
                            toolMarkerCarry = text.slice(-carryLen);
                            return visible;
                        }
                        text = text.slice(endIdx + TOOL_CALL_SECTION_END.length);
                        inToolCallSection = false;
                        continue;
                    }

                    const startIdx = text.indexOf(TOOL_CALL_SECTION_START);
                    if (startIdx === -1) {
                        visible += text;
                        text = '';
                    } else {
                        visible += text.slice(0, startIdx);
                        text = text.slice(startIdx + TOOL_CALL_SECTION_START.length);
                        inToolCallSection = true;
                    }
                }

                const incompleteMarkerIdx = visible.lastIndexOf('<|');
                if (incompleteMarkerIdx !== -1 && visible.indexOf('|>', incompleteMarkerIdx) === -1) {
                    toolMarkerCarry = visible.slice(incompleteMarkerIdx);
                    visible = visible.slice(0, incompleteMarkerIdx);
                }

                visible = visible.replace(/<\|[^|]+\|>/g, '');
                visible = visible.replace(/functions\.\w+:\d+/g, '');

                if (/^\s*\{[\s\S]*"query"[\s\S]*\}\s*$/.test(visible)) {
                    return '';
                }

                return visible;
            };

            const splitEmbeddedThinkContent = (chunk = '', allowReasoning = false) => {
                let text = thinkTagCarry + String(chunk || '');
                thinkTagCarry = '';
                let visible = '';
                let reasoning = '';

                while (text.length > 0) {
                    if (inThinkSection) {
                        const endIdx = text.indexOf(THINK_SECTION_END);
                        if (endIdx === -1) {
                            const safeLen = Math.max(0, text.length - (THINK_SECTION_END.length - 1));
                            const reasoningChunk = text.slice(0, safeLen);
                            if (allowReasoning && reasoningChunk) {
                                reasoning += reasoningChunk;
                            }
                            thinkTagCarry = text.slice(safeLen);
                            return { visible, reasoning };
                        }

                        const reasoningChunk = text.slice(0, endIdx);
                        if (allowReasoning && reasoningChunk) {
                            reasoning += reasoningChunk;
                        }
                        text = text.slice(endIdx + THINK_SECTION_END.length);
                        inThinkSection = false;
                        continue;
                    }

                    const startIdx = text.indexOf(THINK_SECTION_START);
                    if (startIdx === -1) {
                        const partialIdx = text.lastIndexOf('<');
                        if (partialIdx !== -1 && THINK_SECTION_START.startsWith(text.slice(partialIdx))) {
                            visible += text.slice(0, partialIdx);
                            thinkTagCarry = text.slice(partialIdx);
                            return { visible, reasoning };
                        }
                        visible += text;
                        text = '';
                        continue;
                    }

                    visible += text.slice(0, startIdx);
                    text = text.slice(startIdx + THINK_SECTION_START.length);
                    inThinkSection = true;
                }

                return { visible, reasoning };
            };

            // 某些模型会把“累计文本”重复放在后续delta中，这里统一做去重增量提取
            const extractIncrementalChunk = (accumulated = '', incoming = '') => {
                const acc = typeof accumulated === 'string' ? accumulated : String(accumulated || '');
                const inc = typeof incoming === 'string' ? incoming : String(incoming || '');
                if (!inc) return '';
                if (!acc) return inc;
                if (inc === acc) return '';
                if (inc.startsWith(acc)) return inc.slice(acc.length);
                if (acc.endsWith(inc)) return '';

                const maxOverlap = Math.min(acc.length, inc.length);
                for (let i = maxOverlap; i > 0; i -= 1) {
                    if (acc.slice(-i) === inc.slice(0, i)) {
                        return inc.slice(i);
                    }
                }

                return inc;
            };

            // 轮询检查取消状态
            const checkCancellation = async () => {
                return new Promise((resolve) => {
                    db.get('SELECT is_cancelled FROM active_requests WHERE id = ?', [requestId], (err, row) => {
                        resolve(row?.is_cancelled === 1);
                    });
                });
            };

            while (true) {
                const isCancelled = await checkCancellation();
                if (isCancelled) {
                    console.log(` 请求被用户取消: ${requestId}`);
                    res.write(`data: ${JSON.stringify({ type: 'cancelled' })}\n\n`);
                    res.end();
                    reader.cancel();
                    break;
                }

                const { done, value } = await reader.read();
                if (done) {
                    const flushed = buffer + decoder.decode();
                    buffer = flushed ? (flushed + '\n') : '';
                } else {
                    buffer += decoder.decode(value, { stream: true });
                }

                const lines = buffer.split(/\r?\n/);
                buffer = done ? '' : (lines.pop() || '');
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed === 'data: [DONE]') continue;

                    if (trimmed.startsWith('data: ')) {
                        const data = trimmed.slice(6);
                        try {
                            const parsed = JSON.parse(data);
                            if (parsed?.error) {
                                const errPayload = parsed.error;
                                const errMessage = typeof errPayload === 'string'
                                    ? errPayload
                                    : (errPayload?.message || JSON.stringify(errPayload));
                                console.error(` 流式事件错误(${routing.provider}): ${errMessage}`);
                                continue;
                            }

                            const responseEventReasoning = extractReasoningTextFromResponseEvent(parsed);
                            if (responseEventReasoning) {
                                if (thinkingMode) {
                                    const reasoningDelta = extractIncrementalChunk(reasoningContent, responseEventReasoning);
                                    if (reasoningDelta) {
                                        reasoningContent += reasoningDelta;
                                        res.write(`data: ${JSON.stringify({ type: 'reasoning', content: reasoningDelta })}\n\n`);
                                    }
                                }
                                continue;
                            }

                            const responseEventContent = extractOutputTextFromResponseEvent(parsed);
                            if (responseEventContent) {
                                rawToolContent += responseEventContent;
                                const filteredContent = sanitizeStreamingContent(responseEventContent);
                                const splitThinkContent = splitEmbeddedThinkContent(filteredContent, !!thinkingMode);
                                if (splitThinkContent.reasoning) {
                                    const reasoningDelta = extractIncrementalChunk(reasoningContent, splitThinkContent.reasoning);
                                    if (reasoningDelta) {
                                        reasoningContent += reasoningDelta;
                                        res.write(`data: ${JSON.stringify({ type: 'reasoning', content: reasoningDelta })}\n\n`);
                                    }
                                }
                                const incrementalContent = extractIncrementalChunk(fullContent, splitThinkContent.visible);
                                if (incrementalContent.length > 0) {
                                    emitStructuredAssistantChunk(incrementalContent);
                                }
                                continue;
                            }

                            if (isGeminiAPI) {
                                // ============ Gemini 响应格式解析 ============
                                // Gemini 响应结构: { candidates: [{ content: { parts: [{ text: "..." }] } }] }
                                const candidate = parsed.candidates?.[0];
                                if (candidate) {
                                    const parts = candidate.content?.parts || [];
                                    for (const part of parts) {
                                        if (!part.text) continue;
                                        if (part.thought) {
                                            if (thinkingMode) {
                                                const reasoningDelta = extractIncrementalChunk(reasoningContent, part.text);
                                                if (reasoningDelta) {
                                                    reasoningContent += reasoningDelta;
                                                    res.write(`data: ${JSON.stringify({ type: 'reasoning', content: reasoningDelta })}\n\n`);
                                                }
                                            }
                                            continue;
                                        }

                                        const visibleDelta = extractIncrementalChunk(fullContent, part.text);
                                        if (visibleDelta) {
                                            emitStructuredAssistantChunk(visibleDelta);
                                        }
                                    }
                                }
                            } else {
                                // ============ OpenAI 兼容格式解析 ============
                                const choice = parsed.choices?.[0];

                                //  修复：处理推理内容（兼容多家上游）
                                const delta = choice?.delta || {};
                                const reasoning = extractReasoningTextFromPayload(delta);
                                const content = delta.content;

                                if (reasoning && thinkingMode) {
                                    const reasoningDelta = extractIncrementalChunk(reasoningContent, reasoning);
                                    if (reasoningDelta) {
                                        reasoningContent += reasoningDelta;
                                        res.write(`data: ${JSON.stringify({ type: 'reasoning', content: reasoningDelta })}\n\n`);
                                    }
                                }

                                if (content) {
                                    rawToolContent += content;
                                    const filteredContent = sanitizeStreamingContent(content);
                                    const splitThinkContent = splitEmbeddedThinkContent(filteredContent, !!thinkingMode);

                                    if (splitThinkContent.reasoning) {
                                        const reasoningDelta = extractIncrementalChunk(reasoningContent, splitThinkContent.reasoning);
                                        if (reasoningDelta) {
                                            reasoningContent += reasoningDelta;
                                            res.write(`data: ${JSON.stringify({ type: 'reasoning', content: reasoningDelta })}\n\n`);
                                        }
                                    }

                                    const incrementalContent = extractIncrementalChunk(fullContent, splitThinkContent.visible);

                                    if (incrementalContent.length > 0) {
                                        if (agentRuntime.enabled && agentRuntime.selectedAgents.includes('synthesizer') && !agentSynthesizerRunning) {
                                            emitAgentEvent(res, {
                                                type: 'agent_status',
                                                role: 'synthesizer',
                                                status: 'running',
                                                detail: '正在生成候选答案'
                                                });
                                            agentSynthesizerRunning = true;
                                        }
                                        emitStructuredAssistantChunk(incrementalContent);
                                    }
                                }

                                //  流式工具调用：检测 tool_calls
                                if (delta.tool_calls && useStreamingTools) {
                                    for (const tc of delta.tool_calls) {
                                        const idx = tc.index || 0;

                                        // 初始化或更新工具调用
                                        if (!accumulatedToolCalls[idx]) {
                                            accumulatedToolCalls[idx] = {
                                                id: tc.id || `call_${Date.now()}_${idx}`,
                                                type: 'function',
                                                function: {
                                                    name: tc.function?.name || '',
                                                    arguments: ''
                                                }
                                            };
                                        }

                                        // 累积函数名（可能分片传输）
                                        if (tc.function?.name) {
                                            accumulatedToolCalls[idx].function.name = tc.function.name;
                                        }

                                        // 累积参数（JSON字符串分片传输）
                                        if (tc.function?.arguments) {
                                            accumulatedToolCalls[idx].function.arguments += tc.function.arguments;
                                        }
                                    }
                                }

                                // 记录 finish_reason
                                if (choice?.finish_reason) {
                                    streamFinishReason = choice.finish_reason;
                                }

                                // 处理阿里云原生联网的 search_info
                                const searchInfo = parsed.search_info || parsed.output?.search_info;
                                if (searchInfo && searchInfo.search_results && searchInfo.search_results.length > 0) {
                                    const searchResultSources = searchInfo.search_results.map(r => ({
                                        title: r.title || '未知来源',
                                        url: r.url || '',
                                        favicon: r.icon || '',
                                        site_name: r.site_name || '',
                                        provider: 'aliyun_search',
                                        sourceKind: 'web',
                                        markerType: 'numeric',
                                        label: 'Web Search'
                                    }));
                                    const sourceAppendResult = appendAnnotatedSources(searchSources, searchResultSources);
                                    searchSources = sourceAppendResult.merged;
                                    emitSourcesEvent(res, sourceAppendResult.newlyAdded);
                                    console.log(` 阿里云search_info: 已发送 ${sourceAppendResult.newlyAdded.length} 个来源`);
                                }
                            }
                        } catch (e) {
                            console.error(' 解析响应行错误:', e.message);
                        }
                    }
                }

                if (done) {
                    console.log(' 流式响应结束');
                    break;
                }
            }

            const extractFallbackToolCalls = (rawText = '') => {
                const trimmedText = String(rawText || '').trim();
                const fallbackCalls = [];

                if (!trimmedText) return fallbackCalls;

                // 1) JSON 数组格式
                if (trimmedText.startsWith('[') && /(web_search|finance_quote|generate_image|delete_memory)/.test(trimmedText)) {
                    try {
                        const parsedCalls = JSON.parse(trimmedText);
                        if (Array.isArray(parsedCalls)) {
                            for (const call of parsedCalls) {
                                if ((call?.name === 'web_search' || call?.name === 'finance_quote' || call?.name === 'generate_image' || call?.name === 'delete_memory') && call.arguments) {
                                    fallbackCalls.push({
                                        name: call.name,
                                        arguments: call.arguments
                                    });
                                }
                            }
                        }
                    } catch (e) {
                        // ignore
                    }
                }

                // 2) Kimi 标记格式
                if (fallbackCalls.length === 0 && trimmedText.includes('<|tool_call_begin|>')) {
                    const markerRegex = /<\|tool_call_begin\|>\s*functions\.(\w+)(?::\d+)?\s*<\|tool_call_argument_begin\|>\s*({[\s\S]*?})\s*(?:<\|tool_call_end\|>|<\|tool_calls_section_end\|>|$)/g;
                    let markerMatch;
                    while ((markerMatch = markerRegex.exec(trimmedText)) !== null) {
                        const functionName = markerMatch[1];
                        const argumentText = markerMatch[2];
                        if (functionName !== 'web_search' && functionName !== 'finance_quote' && functionName !== 'generate_image' && functionName !== 'delete_memory') continue;

                        try {
                            fallbackCalls.push({
                                name: functionName,
                                arguments: JSON.parse(argumentText)
                            });
                        } catch (e) {
                            console.warn(' 无法解析工具参数(JSON):', argumentText);
                        }
                    }
                }

                // 3) DeepSeek 风格 XML 伪工具调用:
                // <function_calls><invoke name="web_search"><parameter name="query">...</parameter></invoke></function_calls>
                if (fallbackCalls.length === 0 && trimmedText.includes('<invoke')) {
                    const xmlInvokeRegex = /<invoke\s+name=["'](web_search|finance_quote|generate_image|delete_memory)["'][^>]*>([\s\S]*?)<\/invoke>/g;
                    let invokeMatch;
                    while ((invokeMatch = xmlInvokeRegex.exec(trimmedText)) !== null) {
                        const functionName = invokeMatch[1];
                        const body = invokeMatch[2] || '';
                        const args = {};
                        const parameterRegex = /<parameter\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/parameter>/g;
                        let paramMatch;
                        while ((paramMatch = parameterRegex.exec(body)) !== null) {
                            args[paramMatch[1]] = String(paramMatch[2] || '').trim();
                        }
                        if (functionName === 'web_search' && args.query) {
                            fallbackCalls.push({ name: functionName, arguments: { query: args.query } });
                        } else if (functionName === 'finance_quote' && (args.symbol || args.ticker)) {
                            fallbackCalls.push({ name: functionName, arguments: args });
                        } else if (functionName === 'generate_image' && args.prompt) {
                            fallbackCalls.push({ name: functionName, arguments: args });
                        } else if (functionName === 'delete_memory' && (args.memory_id || args.memory_ids || args.memoryId || args.memoryIds || args.id || args.ids || args.target || args.memory || args.content)) {
                            fallbackCalls.push({ name: functionName, arguments: args });
                        }
                    }
                }

                // 4) 松散文本格式
                if (fallbackCalls.length === 0 && trimmedText.includes('functions.')) {
                    const looseRegex = /functions\.(\w+)(?::\d+)?[\s\S]{0,200}?(\{[\s\S]*?"(?:query|symbol|prompt|memory_id|memory_ids|memoryId|memoryIds|target)"[\s\S]*?\})/g;
                    let looseMatch;
                    while ((looseMatch = looseRegex.exec(trimmedText)) !== null) {
                        const functionName = looseMatch[1];
                        const argumentText = looseMatch[2];
                        if (functionName !== 'web_search' && functionName !== 'finance_quote' && functionName !== 'generate_image' && functionName !== 'delete_memory') continue;

                        try {
                            fallbackCalls.push({
                                name: functionName,
                                arguments: JSON.parse(argumentText)
                            });
                        } catch (e) {
                            // ignore broken fragments
                        }
                    }
                }

                return fallbackCalls;
            };

            const normalizeToolCalls = (toolCalls = []) => {
                const normalized = [];
                for (const toolCall of toolCalls) {
                    if (!toolCall || !toolCall.function?.name) continue;

                    let args;
                    try {
                        args = JSON.parse(toolCall.function.arguments || '{}');
                    } catch (e) {
                        continue;
                    }

                    const toolName = String(toolCall.function.name || '').trim();
                    if (!hasToolDefinition(runtimeToolDefinitions, toolName)) {
                        continue;
                    }
                    if (toolName === 'web_search') {
                        if (!args || typeof args !== 'object' || typeof args.query !== 'string' || !args.query.trim()) {
                            continue;
                        }

                        normalized.push({
                            ...toolCall,
                            function: {
                                ...toolCall.function,
                                arguments: JSON.stringify({ query: args.query.trim() })
                            },
                            _args: { query: args.query.trim() }
                        });
                        continue;
                    }

                    if (toolName === 'generate_image') {
                        let normalizedArgs;
                        try {
                            normalizedArgs = normalizeKolorsImageArgs(args);
                        } catch (error) {
                            continue;
                        }
                        normalized.push({
                            ...toolCall,
                            function: {
                                ...toolCall.function,
                                arguments: JSON.stringify(normalizedArgs)
                            },
                            _args: normalizedArgs
                        });
                        continue;
                    }

                    if (toolName === 'finance_quote') {
                        const rawSymbol = String(args.symbol || args.ticker || '').trim();
                        if (!rawSymbol) {
                            continue;
                        }

                        let normalizedArgs;
                        try {
                            normalizedArgs = {
                                symbol: resolveFinanceSymbol(rawSymbol),
                                range: normalizeFinanceRange(args.range || FINANCE_DEFAULT_RANGE),
                                interval: normalizeFinanceInterval(args.interval || FINANCE_DEFAULT_INTERVAL)
                            };
                        } catch (error) {
                            continue;
                        }

                        normalized.push({
                            ...toolCall,
                            function: {
                                ...toolCall.function,
                                arguments: JSON.stringify(normalizedArgs)
                            },
                            _args: normalizedArgs
                        });
                        continue;
                    }

                    if (toolName === 'delete_memory') {
                        const normalizedArgs = normalizeDeleteMemoryToolArgs(args);
                        if (!normalizedArgs) {
                            continue;
                        }

                        normalized.push({
                            ...toolCall,
                            function: {
                                ...toolCall.function,
                                arguments: JSON.stringify(normalizedArgs)
                            },
                            _args: normalizedArgs
                        });
                    }
                }
                return normalized;
            };

            // 初始流 fallback：模型可能把 tool_calls 作为文本输出
            if (useStreamingTools && accumulatedToolCalls.length === 0 && rawToolContent) {
                const fallbackCalls = extractFallbackToolCalls(rawToolContent);
                if (fallbackCalls.length > 0) {
                    console.log(` 检测到 AI 以文本形式输出工具调用，已转换为标准 tool_calls: ${fallbackCalls.length} 个`);
                    for (let i = 0; i < fallbackCalls.length; i++) {
                        const call = fallbackCalls[i];
                        accumulatedToolCalls.push({
                            id: `fallback_call_${Date.now()}_${i}`,
                            type: 'function',
                            function: {
                                name: call.name,
                                arguments: JSON.stringify(call.arguments)
                            }
                        });
                    }
                }
            }

            if (useStreamingTools && imageGenerationRequested && accumulatedToolCalls.length === 0) {
                console.warn(' 图片生成意图已识别，但模型未触发工具调用，服务端合成 generate_image 调用');
                accumulatedToolCalls.push({
                    id: `forced_image_call_${Date.now()}`,
                    type: 'function',
                    function: {
                        name: 'generate_image',
                        arguments: JSON.stringify({ prompt: userContent })
                    }
                });
                streamFinishReason = 'tool_calls';
            }

            if (useStreamingTools && streamFinishReason !== 'tool_calls' && accumulatedToolCalls.length === 0) {
                console.warn(` 工具模式已开启，但模型未触发工具调用: model=${actualModel}`);
                if (agentRuntime.enabled && agentRuntime.selectedAgents.includes('researcher')) {
                    emitAgentEvent(res, {
                        type: 'agent_status',
                        role: 'researcher',
                        status: 'done',
                        detail: '本轮未触发外部检索'
                    });
                }
            }

            // 流式 + 多轮工具调用
            if (useStreamingTools && accumulatedToolCalls.length > 0) {
                let pendingToolCalls = normalizeToolCalls(accumulatedToolCalls);
                if (pendingToolCalls.length === 0) {
                    console.warn(` 收到 tool_calls 但均无效，已跳过`);
                } else {
                    let toolRound = 0;
                    const maxToolRounds = 5;
                    let conversationMessages = [...finalMessages];

                    while (pendingToolCalls.length > 0 && toolRound < maxToolRounds) {
                        toolRound += 1;
                        console.log(` 工具调用轮次: ${toolRound}, calls=${pendingToolCalls.length}`);

                        const executedToolResults = [];
                        for (const toolCall of pendingToolCalls) {
                            const toolName = toolCall.function.name;
                            const args = toolCall._args;

                            console.log(` 执行工具: ${toolName}, args=${JSON.stringify(args)}`);
                            const isSearchTool = toolName === 'web_search';
                            const isImageTool = toolName === 'generate_image';
                            const isMemoryDeleteTool = toolName === 'delete_memory';
                            if (isSearchTool && agentRuntime.enabled && agentRuntime.selectedAgents.includes('researcher')) {
                                emitAgentEvent(res, {
                                    type: 'agent_status',
                                    role: 'researcher',
                                    status: 'running',
                                    detail: `检索中: ${args.query}`
                                });
                                agentResearcherRunning = true;
                            }
                            if (isSearchTool) {
                                res.write(`data: ${JSON.stringify({
                                    type: 'search_status',
                                    status: 'searching',
                                    query: args.query,
                                    message: `正在搜索: "${args.query}"`
                                })}\n\n`);
                            }
                            if (isImageTool) {
                                res.write(`data: ${JSON.stringify({
                                    type: 'tool_status',
                                    tool: 'generate_image',
                                    status: 'running',
                                    message: '正在生成图片中'
                                })}\n\n`);
                            }
                            if (isMemoryDeleteTool) {
                                res.write(`data: ${JSON.stringify({
                                    type: 'tool_status',
                                    tool: 'delete_memory',
                                    status: 'running',
                                    message: '正在删除指定记忆'
                                })}\n\n`);
                            }

                            const executor = TOOL_EXECUTORS[toolName];
                            if (!executor) {
                                console.warn(` 未找到工具执行器: ${toolName}`);
                                continue;
                            }

                            const searchDepth = isSearchTool ? getTavilySearchDepth(actualModel, thinkingMode) : null;
                            let result;
                            try {
                                if (isImageTool) {
                                    const waitingLinePromise = buildImageWaitingLineFromUserPrompt(userContent);
                                    const resultPromise = executor(args);
                                    const firstImageEvent = await Promise.race([
                                        waitingLinePromise.then((line) => ({ kind: 'line', line })).catch(() => ({ kind: 'line', line: '' })),
                                        resultPromise.then((value) => ({ kind: 'result', value }), (error) => ({ kind: 'error', error })),
                                        new Promise((resolve) => setTimeout(() => resolve({ kind: 'timeout' }), 1800))
                                    ]);
                                    if (firstImageEvent.kind === 'line' && firstImageEvent.line) {
                                        res.write(`data: ${JSON.stringify({
                                            type: 'tool_status',
                                            tool: 'generate_image',
                                            status: 'running',
                                            message: firstImageEvent.line,
                                            generatedBy: IMAGE_WAITING_LINE_MODEL_ID
                                        })}\n\n`);
                                    } else if (firstImageEvent.kind === 'result') {
                                        result = firstImageEvent.value;
                                    } else if (firstImageEvent.kind === 'error') {
                                        throw firstImageEvent.error;
                                    }
                                    if (!result) {
                                        result = await resultPromise;
                                    }
                                } else {
                                    if (isSearchTool) {
                                        result = await executor(args, searchDepth);
                                    } else if (isMemoryDeleteTool) {
                                        result = await executor(args, { userId: req.user.userId, sessionId });
                                    } else {
                                        result = await executor(args);
                                    }
                                }
                            } catch (toolError) {
                                appendRaiRuntimeReport({
                                    level: '报错',
                                    tag: 'tool_execution_failed',
                                    message: toolError.message,
                                    context: {
                                        sessionId,
                                        requestId,
                                        toolName,
                                        model: finalModel,
                                        provider: routing?.provider,
                                        args
                                    }
                                });
                                res.write(`data: ${JSON.stringify({
                                    type: (isImageTool || isMemoryDeleteTool) ? 'tool_status' : 'search_status',
                                    tool: toolName,
                                    status: 'failed',
                                    query: args.query || args.prompt || args.symbol || args.target || args.memory_id || '',
                                    message: isImageTool ? '图片生成失败，已记录报错' : (isMemoryDeleteTool ? '记忆删除失败，已记录报错' : '工具调用失败，已记录报错')
                                })}\n\n`);
                                executedToolResults.push({
                                    toolCall,
                                    result: {
                                        error: true,
                                        tool: toolName,
                                        message: buildUserFacingApiFailureMessage()
                                    }
                                });
                                continue;
                            }

                            if (isSearchTool) {
                                const searchResults = result.results || result;
                                let searchImages = result.images || [];
                                if (searchImages.length > 0) {
                                    searchImages = await filterValidImages(searchImages, 5, 3000);
                                }

                                if (searchResults && searchResults.length > 0) {
                                    const currentSources = extractSourcesForSSE(searchResults);
                                    const sourceAppendResult = appendAnnotatedSources(searchSources, currentSources);
                                    searchSources = sourceAppendResult.merged;

                                    res.write(`data: ${JSON.stringify({
                                        type: 'search_status',
                                        status: 'complete',
                                        query: args.query,
                                        resultCount: searchResults.length,
                                        message: `找到 ${searchResults.length} 条结果`
                                    })}\n\n`);

                                    emitSourcesEvent(res, sourceAppendResult.newlyAdded);
                                    executedToolResults.push({
                                        toolCall,
                                        result: buildToolResultForLLM({
                                            toolName,
                                            result: {
                                                ...result,
                                                images: searchImages
                                            },
                                            sources: sourceAppendResult.newlyAdded,
                                            args
                                        })
                                    });
                                    console.log(` 工具执行完成: ${searchResults.length} 条结果`);
                                    if (agentRuntime.enabled && agentRuntime.selectedAgents.includes('researcher')) {
                                        emitAgentEvent(res, {
                                            type: 'agent_status',
                                            role: 'researcher',
                                            status: 'done',
                                            detail: `完成检索: ${searchResults.length} 条结果`
                                        });
                                        agentResearcherRunning = false;
                                    }
                                } else {
                                    res.write(`data: ${JSON.stringify({
                                        type: 'search_status',
                                        status: 'no_results',
                                        query: args.query,
                                        message: '未找到相关结果'
                                    })}\n\n`);
                                    executedToolResults.push({
                                        toolCall,
                                        result: buildToolResultForLLM({
                                            toolName,
                                            result: {
                                                ...result,
                                                images: searchImages
                                            },
                                            sources: [],
                                            args
                                        })
                                    });
                                    if (agentRuntime.enabled && agentRuntime.selectedAgents.includes('researcher')) {
                                        emitAgentEvent(res, {
                                            type: 'agent_status',
                                            role: 'researcher',
                                            status: 'done',
                                            detail: '检索完成: 无结果'
                                        });
                                        agentResearcherRunning = false;
                                    }
                                }
                            } else if (toolName === 'finance_quote') {
                                const financeSources = buildFinanceSourceForSSE(result);
                                const sourceAppendResult = appendAnnotatedSources(searchSources, financeSources);
                                searchSources = sourceAppendResult.merged;
                                emitSourcesEvent(res, sourceAppendResult.newlyAdded);
                                executedToolResults.push({
                                    toolCall,
                                    result: buildToolResultForLLM({
                                        toolName,
                                        result,
                                        sources: sourceAppendResult.newlyAdded,
                                        args
                                    })
                                });
                                console.log(` 工具执行完成: finance_quote symbol=${result?.resolvedSymbol || args.symbol}`);
                            } else if (isImageTool) {
                                const imageMarkdown = buildGeneratedImageMarkdown(result);
                                if (imageMarkdown) {
                                    emitStructuredAssistantChunk(`\n\n${imageMarkdown}\n\n`);
                                }
                                executedToolResults.push({
                                    toolCall,
                                    result: buildToolResultForLLM({
                                        toolName,
                                        result,
                                        sources: [],
                                        args
                                    })
                                });
                                res.write(`data: ${JSON.stringify({
                                    type: 'tool_status',
                                    tool: 'generate_image',
                                    status: 'complete',
                                    message: `生成 ${result?.images?.length || 0} 张图片`
                                })}\n\n`);
                                console.log(` 工具执行完成: generate_image count=${result?.images?.length || 0}`);
                            } else if (isMemoryDeleteTool) {
                                executedToolResults.push({
                                    toolCall,
                                    result: buildToolResultForLLM({
                                        toolName,
                                        result,
                                        sources: [],
                                        args
                                    })
                                });
                                const updatedMemories = await listActiveUserMemories(req.user.userId, 200).catch(() => []);
                                res.write(`data: ${JSON.stringify({
                                    type: 'tool_status',
                                    tool: 'delete_memory',
                                    status: result?.success ? 'complete' : 'no_results',
                                    message: result?.message || (result?.success ? '已删除指定记忆' : '未找到指定记忆')
                                })}\n\n`);
                                res.write(`data: ${JSON.stringify({
                                    type: 'memory_update',
                                    enabled: true,
                                    memories: updatedMemories
                                })}\n\n`);
                                console.log(` 工具执行完成: delete_memory success=${!!result?.success}, deleted=${Number(result?.deletedCount || 0)}`);
                            }
                        }

                        if (executedToolResults.length === 0) {
                            console.warn(` 本轮没有可执行的工具结果，结束工具循环`);
                            break;
                        }

                        // 将本轮工具调用 + 工具结果加入上下文，发起下一轮流式生成
                        const assistantToolCallMessage = {
                            role: 'assistant',
                            content: null,
                            tool_calls: executedToolResults.map(({ toolCall }) => ({
                                id: toolCall.id,
                                type: 'function',
                                function: {
                                    name: toolCall.function.name,
                                    arguments: toolCall.function.arguments
                                }
                            }))
                        };
                        const toolResultMessages = executedToolResults.map(({ toolCall, result }) => ({
                            role: 'tool',
                            tool_call_id: toolCall.id,
                            content: JSON.stringify(result)
                        }));
                        conversationMessages = [...conversationMessages, assistantToolCallMessage, ...toolResultMessages];

                        const continueRequestBody = {
                            model: actualModel,
                            messages: conversationMessages,
                            max_tokens: parseInt(max_tokens, 10) || 2000,
                            stream: true,
                            tools: runtimeToolDefinitions,
                            tool_choice: "auto"
                        };
                        if (routing.provider === 'openrouter' && Array.isArray(routing.fallbackModels) && routing.fallbackModels.length > 1) {
                            continueRequestBody.models = routing.fallbackModels;
                        }

                        if (isKimiK25Model) {
                            if (routing.provider === 'siliconflow') {
                                continueRequestBody.enable_thinking = !!thinkingMode;
                            } else {
                                continueRequestBody.thinking = { type: thinkingMode ? 'enabled' : 'disabled' };
                            }
                        } else {
                            continueRequestBody.temperature = parseFloat(temperature) || 0.7;
                            continueRequestBody.top_p = parseFloat(top_p) || 0.9;
                            const continueThinkingBudget = resolveThinkingBudgetForModel(actualModel, !!thinkingMode, thinkingBudget);
                            if (continueThinkingBudget !== null) {
                                continueRequestBody.thinking_budget = continueThinkingBudget;
                            }
                        }
                        if (routing.provider === 'deepseek') {
                            applyDeepSeekV4ModeParams(continueRequestBody, !!thinkingMode, normalizedReasoningProfile);
                        }
                        if (routing.provider === 'newapi') {
                            applyNewApiModelParams(continueRequestBody, actualModel, !!thinkingMode, normalizedReasoningProfile);
                        }
                        if (routing.provider === 'openrouter') {
                            applyOpenRouterReasoningParams(continueRequestBody, actualModel, !!thinkingMode, normalizedReasoningProfile);
                        }
                        console.log(` 发起续传流式调用 (round=${toolRound})...`);
                        // 重置工具标记清洗器状态，避免跨轮污染
                        toolMarkerCarry = '';
                        inToolCallSection = false;
                        thinkTagCarry = '';
                        inThinkSection = false;

                        const continueResponse = await fetch(providerConfig.baseURL, {
                            method: 'POST',
                            headers: buildProviderFetchHeaders(providerConfig, routing.provider),
                            body: JSON.stringify(continueRequestBody)
                        });

                        if (!continueResponse.ok) {
                            const continueErr = await continueResponse.text();
                            console.error(` 续传请求失败: ${continueResponse.status} ${continueErr.substring(0, 300)}`);
                            break;
                        }

                        const continueReader = continueResponse.body.getReader();
                        const continueDecoder = new TextDecoder('utf-8');
                        let continueBuffer = '';
                        let continueRawToolContent = '';
                        let continueStreamFinishReason = null;
                        const continueAccumulatedToolCalls = [];

                        while (true) {
                            const { done: continueDone, value: continueValue } = await continueReader.read();
                            if (continueDone) {
                                const continueFlushed = continueBuffer + continueDecoder.decode();
                                continueBuffer = continueFlushed ? (continueFlushed + '\n') : '';
                            } else {
                                continueBuffer += continueDecoder.decode(continueValue, { stream: true });
                            }

                            const continueLines = continueBuffer.split(/\r?\n/);
                            continueBuffer = continueDone ? '' : (continueLines.pop() || '');
                            for (const continueLine of continueLines) {
                                const continueTrimmed = continueLine.trim();
                                if (!continueTrimmed || continueTrimmed === 'data: [DONE]') continue;
                                if (!continueTrimmed.startsWith('data: ')) continue;

                                try {
                                    const continueParsed = JSON.parse(continueTrimmed.slice(6));
                                    const continueEventReasoning = extractReasoningTextFromResponseEvent(continueParsed);
                                    if (continueEventReasoning) {
                                        if (thinkingMode) {
                                            const reasoningDelta = extractIncrementalChunk(reasoningContent, continueEventReasoning);
                                            if (reasoningDelta) {
                                                reasoningContent += reasoningDelta;
                                                res.write(`data: ${JSON.stringify({ type: 'reasoning', content: reasoningDelta })}\n\n`);
                                            }
                                        }
                                        continue;
                                    }

                                    const continueEventContent = extractOutputTextFromResponseEvent(continueParsed);
                                    if (continueEventContent) {
                                        continueRawToolContent += continueEventContent;
                                        rawToolContent += continueEventContent;
                                        const filteredContinueContent = sanitizeStreamingContent(continueEventContent);
                                        const splitContinueThink = splitEmbeddedThinkContent(filteredContinueContent, !!thinkingMode);
                                        if (splitContinueThink.reasoning) {
                                            const reasoningDelta = extractIncrementalChunk(reasoningContent, splitContinueThink.reasoning);
                                            if (reasoningDelta) {
                                                reasoningContent += reasoningDelta;
                                                res.write(`data: ${JSON.stringify({ type: 'reasoning', content: reasoningDelta })}\n\n`);
                                            }
                                        }
                                        const incrementalContinueContent = extractIncrementalChunk(fullContent, splitContinueThink.visible);
                                        if (incrementalContinueContent.length > 0) {
                                            emitStructuredAssistantChunk(incrementalContinueContent);
                                        }
                                        continue;
                                    }

                                    const continueChoice = continueParsed.choices?.[0];
                                    const continueDelta = continueChoice?.delta || {};

                                    if (continueChoice?.finish_reason) {
                                        continueStreamFinishReason = continueChoice.finish_reason;
                                    }

                                    const reasoning = extractReasoningTextFromPayload(continueDelta);
                                    if (reasoning && thinkingMode) {
                                        const reasoningDelta = extractIncrementalChunk(reasoningContent, reasoning);
                                        if (reasoningDelta) {
                                            reasoningContent += reasoningDelta;
                                            res.write(`data: ${JSON.stringify({ type: 'reasoning', content: reasoningDelta })}\n\n`);
                                        }
                                    }

                                    if (continueDelta.content) {
                                        continueRawToolContent += continueDelta.content;
                                        rawToolContent += continueDelta.content;
                                        const filteredContinueContent = sanitizeStreamingContent(continueDelta.content);
                                        const splitContinueThink = splitEmbeddedThinkContent(filteredContinueContent, !!thinkingMode);
                                        if (splitContinueThink.reasoning) {
                                            const reasoningDelta = extractIncrementalChunk(reasoningContent, splitContinueThink.reasoning);
                                            if (reasoningDelta) {
                                                reasoningContent += reasoningDelta;
                                                res.write(`data: ${JSON.stringify({ type: 'reasoning', content: reasoningDelta })}\n\n`);
                                            }
                                        }
                                        const incrementalContinueContent = extractIncrementalChunk(fullContent, splitContinueThink.visible);
                                        if (incrementalContinueContent.length > 0) {
                                            if (agentRuntime.enabled && agentRuntime.selectedAgents.includes('synthesizer') && !agentSynthesizerRunning) {
                                                emitAgentEvent(res, {
                                                    type: 'agent_status',
                                                    role: 'synthesizer',
                                                    status: 'running',
                                                    detail: '正在生成候选答案'
                                                });
                                                agentSynthesizerRunning = true;
                                            }
                                            emitStructuredAssistantChunk(incrementalContinueContent);
                                        }
                                    }

                                    if (continueDelta.tool_calls && useStreamingTools) {
                                        for (const tc of continueDelta.tool_calls) {
                                            const idx = tc.index || 0;
                                            if (!continueAccumulatedToolCalls[idx]) {
                                                continueAccumulatedToolCalls[idx] = {
                                                    id: tc.id || `continue_call_${Date.now()}_${idx}`,
                                                    type: 'function',
                                                    function: {
                                                        name: tc.function?.name || '',
                                                        arguments: ''
                                                    }
                                                };
                                            }
                                            if (tc.function?.name) {
                                                continueAccumulatedToolCalls[idx].function.name = tc.function.name;
                                            }
                                            if (tc.function?.arguments) {
                                                continueAccumulatedToolCalls[idx].function.arguments += tc.function.arguments;
                                            }
                                        }
                                    }
                                } catch (e) {
                                    // ignore
                                }
                            }

                            if (continueDone) {
                                break;
                            }
                        }

                        // 续传流 fallback：处理文本型工具调用标记
                        if (continueAccumulatedToolCalls.length === 0 && continueRawToolContent) {
                            const fallbackCalls = extractFallbackToolCalls(continueRawToolContent);
                            if (fallbackCalls.length > 0) {
                                for (let i = 0; i < fallbackCalls.length; i++) {
                                    const call = fallbackCalls[i];
                                    continueAccumulatedToolCalls.push({
                                        id: `continue_fallback_call_${Date.now()}_${i}`,
                                        type: 'function',
                                        function: {
                                            name: call.name,
                                            arguments: JSON.stringify(call.arguments)
                                        }
                                    });
                                }
                            }
                        }

                        pendingToolCalls = normalizeToolCalls(continueAccumulatedToolCalls);
                        console.log(` 续传流式调用完成 (round=${toolRound}), next_tool_calls=${pendingToolCalls.length}, finish_reason=${continueStreamFinishReason || 'unknown'}`);
                    }

                    if (toolRound >= maxToolRounds && pendingToolCalls.length > 0) {
                        console.warn(` 工具调用轮次达到上限(${maxToolRounds})，强制结束以避免死循环`);
                    }
                }
            }
        } catch (fetchError) {

            clearTimeout(timeoutId);
            if (fetchError.name === 'AbortError') {
                console.error(' API请求超时 (120s)');
                sendFinalApiFailure('model_api_timeout', fetchError.message, {
                    errorName: fetchError.name
                });
            } else if (fetchError.cause?.code === 'UND_ERR_CONNECT_TIMEOUT') {
                console.error(' 连接超时:', fetchError.message);
                console.error('   可能原因: 1) 网络不稳定 2) API服务响应慢 3) 防火墙阻止');
                sendFinalApiFailure('model_api_connect_timeout', fetchError.message, {
                    causeCode: fetchError.cause?.code
                });
            } else {
                console.error(' Fetch错误:', fetchError);
                sendFinalApiFailure('model_api_fetch_error', fetchError.message, {
                    errorName: fetchError.name,
                    causeCode: fetchError.cause?.code
                });
            }
            return;
        }

        if (agentRuntime.enabled) {
            if (agentRuntime.selectedAgents.includes('synthesizer')) {
                emitAgentEvent(res, {
                    type: 'agent_status',
                    role: 'synthesizer',
                    status: 'done',
                    detail: '候选答案生成完成'
                });
            }

            if (agentRuntime.selectedAgents.includes('verifier')) {
                emitAgentEvent(res, {
                    type: 'agent_status',
                    role: 'verifier',
                    status: 'start',
                    detail: '开始质量审查'
                });
                emitAgentEvent(res, {
                    type: 'agent_status',
                    role: 'verifier',
                    status: 'running',
                    detail: '执行事实与一致性校验'
                });

                let qualityResult = runVerifier({
                    qualityProfile: agentRuntime.qualityProfile,
                    content: fullContent,
                    sources: searchSources,
                    fingerprint: agentRuntime.fingerprint
                });

                emitAgentEvent(res, {
                    type: 'agent_quality',
                    pass: qualityResult.pass,
                    profile: agentRuntime.qualityProfile,
                    metrics: qualityResult.metrics,
                    thresholds: qualityResult.thresholds,
                    round: agentRuntime.retriesUsed
                });

                while (!qualityResult.pass && agentRuntime.retriesUsed < AGENT_MAX_RETRIES) {
                    agentRuntime.retriesUsed += 1;
                    const reason = `coverage=${qualityResult.metrics.claimCoverage}, contradictions=${qualityResult.metrics.contradictionCount}, sourceQuality=${qualityResult.metrics.sourceQualityScore}`;
                    emitAgentEvent(res, {
                        type: 'agent_retry',
                        round: agentRuntime.retriesUsed,
                        reason,
                        action: agentRuntime.retriesUsed < AGENT_MAX_RETRIES ? 'recheck' : 'degrade_to_conservative'
                    });

                    if (agentRuntime.retriesUsed >= AGENT_MAX_RETRIES) {
                        const conservativeNote = buildConservativeFallbackNote(agentRuntime.fingerprint);
                        emitStructuredAssistantChunk(conservativeNote);
                    }

                    qualityResult = runVerifier({
                        qualityProfile: agentRuntime.qualityProfile,
                        content: fullContent,
                        sources: searchSources,
                        fingerprint: agentRuntime.fingerprint
                    });

                    emitAgentEvent(res, {
                        type: 'agent_quality',
                        pass: qualityResult.pass,
                        profile: agentRuntime.qualityProfile,
                        metrics: qualityResult.metrics,
                        thresholds: qualityResult.thresholds,
                        round: agentRuntime.retriesUsed
                    });
                }

                emitAgentEvent(res, {
                    type: 'agent_status',
                    role: 'verifier',
                    status: 'done',
                    detail: qualityResult.pass ? '质量门控通过' : '质量门控未通过，已降级保守输出'
                });
            } else {
                const qualityResult = runVerifier({
                    qualityProfile: agentRuntime.qualityProfile,
                    content: fullContent,
                    sources: searchSources,
                    fingerprint: agentRuntime.fingerprint || { freshnessNeed: internetMode }
                });
                emitAgentEvent(res, {
                    type: 'agent_quality',
                    pass: qualityResult.pass,
                    profile: agentRuntime.qualityProfile,
                    metrics: qualityResult.metrics,
                    thresholds: qualityResult.thresholds,
                    round: 0
                });
            }
        }

        //  完整的消息保存逻辑
        if (sessionId) {
            console.log('\n 开始保存消息到数据库');

            // 1. 保存用户消息（包含附件信息）
            const lastUserMsg = messages[messages.length - 1];
            if (shouldSkipUserSave) {
                console.log(' 重新生成请求: 跳过重复保存用户消息');
            } else if (lastUserMsg && lastUserMsg.role === 'user') {
                const userContent = typeof lastUserMsg.content === 'string'
                    ? stripInlinePromptTimeHint(lastUserMsg.content)
                    : JSON.stringify(lastUserMsg.content);

                // 提取附件信息用于保存（仅保存预览所需的精简数据）
                let attachmentsJson = null;
                // 防御性检查：确保 attachments 是数组
                if (lastUserMsg.attachments && Array.isArray(lastUserMsg.attachments) && lastUserMsg.attachments.length > 0) {
                    const previewAttachments = lastUserMsg.attachments.map(att => {
                        // 对于图片，保存缩小的预览版本（减少数据库存储）
                        // 对于视频/音频，只保存类型和文件名
                        if (att.type === 'image' && att.data) {
                            return {
                                type: 'image',
                                fileName: att.fileName,
                                // 保存原始data用于预览（Base64）
                                data: att.data
                            };
                        } else {
                            return {
                                type: att.type,
                                fileName: att.fileName
                            };
                        }
                    });
                    attachmentsJson = JSON.stringify(previewAttachments);
                    console.log(` 保存 ${previewAttachments.length} 个附件信息`);
                }

                // 使用毫秒级时间戳确保用户消息严格早于AI消息
                const userMsgTimestamp = new Date().toISOString();
                await new Promise((resolve, reject) => {
                    db.run(
                        'INSERT INTO messages (session_id, role, content, attachments, created_at) VALUES (?, ?, ?, ?, ?)',
                        [sessionId, 'user', userContent, attachmentsJson, userMsgTimestamp],
                        (err) => {
                            if (err) {
                                console.error(' 保存用户消息失败:', err);
                                reject(err);
                            } else {
                                console.log(` 用户消息已保存 (${userContent.length}字符${attachmentsJson ? ', 含附件' : ''})`);
                                resolve();
                            }
                        }
                    );
                });
            }

            // 2. 提取并处理标题 / 画布Patch (如果存在)
            let contentToSave = fullContent || (reasoningContent ? '(纯思考内容)' : '(生成中断)');
            // 兜底清洗：避免工具调用标记残留到数据库
            contentToSave = contentToSave
                .replace(/<\|[^|]+\|>/g, '')
                .replace(/functions\.\w+:\d+/g, '')
                .trim();
            const structuredAssistantOutput = parseStructuredAssistantOutput(rawAssistantStructuredBuffer || contentToSave);
            contentToSave = sanitizeAssistantVisibleContent(structuredAssistantOutput.visibleContent || contentToSave).trim();
            if (!contentToSave) {
                contentToSave = reasoningContent ? '(纯思考内容)' : '(生成中断)';
            }
            const directTitle = sanitizeGeneratedConversationTitle(structuredAssistantOutput.extractedTitle || '', uiLanguage);
            if (directTitle) {
                console.log(` 已取得会话标题: "${directTitle}"`);
            }

            // 3. 保存AI回复 (已移除标题标记, 包含联网来源信息)
            // 序列化 sources 为 JSON 字符串
            const sourcesJson = (searchSources && searchSources.length > 0) ? JSON.stringify(searchSources) : null;
            const assistantProcessTraceJson = promptContextTrace ? JSON.stringify(promptContextTrace) : null;

            // 使用毫秒级时间戳，确保AI消息严格晚于用户消息
            const aiMsgTimestamp = new Date().toISOString();
            await new Promise((resolve, reject) => {
                db.run(
                    'INSERT INTO messages (session_id, role, content, reasoning_content, model, enable_search, thinking_mode, internet_mode, sources, process_trace, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [sessionId, 'assistant', contentToSave, reasoningContent || null, finalModel, internetMode ? 1 : 0, thinkingMode ? 1 : 0, internetMode ? 1 : 0, sourcesJson, assistantProcessTraceJson, aiMsgTimestamp],
                    (err) => {
                        if (err) {
                            console.error(' 保存AI消息失败:', err);
                            reject(err);
                        } else {
                            console.log(` AI回复已保存:`);
                            console.log(`   - 内容: ${contentToSave.length}字符`);
                            console.log(`   - 思考: ${reasoningContent.length}字符`);
                            console.log(`   - 模型: ${finalModel}`);
                            console.log(`   - 联网: ${internetMode ? '是' : '否'}`);
                            console.log(`   - 思考模式: ${thinkingMode ? '是' : '否'}`);
                            console.log(`   - 来源数: ${searchSources?.length || 0}`);
                            resolve();
                        }
                    }
                );
            });


            // 4. 更新会话标题：AI 直接输出 [TITLE] 时同步更新；未输出时后台兜底，不阻塞 done。
            if (directTitle) {
                await updateSessionOrFlowTitleAndEmit({
                    res,
                    sessionId,
                    flowId,
                    userId: req.user.userId,
                    title: directTitle
                });
            } else {
                scheduleFallbackConversationTitleUpdate({
                    sessionId,
                    flowId,
                    userId: req.user.userId,
                    userContent,
                    assistantContent: contentToSave,
                    uiLanguage
                });
            }

            if (flowId && structuredAssistantOutput.canvasPatchRaw) {
                res.write(`data: ${JSON.stringify({
                    type: 'canvas_patch',
                    patch: structuredAssistantOutput.canvasPatch,
                    raw: structuredAssistantOutput.canvasPatchRaw,
                    valid: !structuredAssistantOutput.canvasPatchParseError,
                    error: structuredAssistantOutput.canvasPatchParseError || null
                })}\n\n`);
            }

            // 5. 更新会话时间戳
            await new Promise((resolve) => {
                db.run(
                    'UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                    [sessionId],
                    (err) => {
                        if (err) console.error(' 更新会话时间戳失败:', err);
                        else console.log(' 会话时间戳已更新');
                        resolve();
                    }
                );
            });

            if (!memoryModeOff && !flowId && !shouldSkipUserSave && !memoryDeleteToolRequested) {
                scheduleConversationMemoryProcessing({
                    userId: req.user.userId,
                    sessionId,
                    userContent,
                    assistantContent: contentToSave || ''
                });
            }

            if (liveStreamState) {
                liveStreamState.assistantContent = contentToSave;
                liveStreamState.reasoningContent = reasoningContent || '';
                liveStreamState.model = finalModel;
                liveStreamState.status = 'done';
                liveStreamState.updatedAt = Date.now();
                await persistSessionStreamDraft(liveStreamState, true);
                broadcastSessionStreamState(liveStreamState, 'session_stream_done');
                cleanupSessionStreamState(sessionId, requestId);
            }
        }

        if (agentRuntime.enabled) {
            emitAgentEvent(res, {
                type: 'agent_status',
                role: 'master',
                status: 'done',
                detail: `编排完成 (retries=${agentRuntime.retriesUsed || 0})`
            });
        }

        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
        res.end();

        console.log('\n 聊天处理完成\n');

    } catch (error) {
        console.error(' 聊天错误:', error);
        if (liveStreamState && liveStreamState.status === 'running') {
            liveStreamState.status = 'failed';
            liveStreamState.updatedAt = Date.now();
            await persistSessionStreamDraft(liveStreamState, true);
            broadcastSessionStreamState(liveStreamState, 'session_stream_failed');
            cleanupSessionStreamState(liveStreamState.sessionId, requestId);
        }
        try {
            res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
            res.end();
        } catch (writeError) {
            console.error(' 写入响应错误:', writeError);
        }
    } finally {
        if (liveStreamState && liveStreamState.status === 'running') {
            liveStreamState.status = 'failed';
            liveStreamState.updatedAt = Date.now();
            await persistSessionStreamDraft(liveStreamState, true);
            broadcastSessionStreamState(liveStreamState, 'session_stream_failed');
            cleanupSessionStreamState(liveStreamState.sessionId, requestId);
        }
        //  关键修复：添加null检查
        if (requestId) {
            activeRequestInterjections.delete(requestId);
            db.run('DELETE FROM active_requests WHERE id = ?', [requestId]);
        }
    }
});

app.post('/api/chat/stop', authenticateToken, (req, res) => {
    const { requestId } = req.body;

    if (!requestId) {
        return res.status(400).json({ error: '缺少requestId' });
    }

    db.get(
        'SELECT user_id FROM active_requests WHERE id = ?',
        [requestId],
        (err, row) => {
            if (err || !row) {
                return res.status(404).json({ error: '请求不存在' });
            }

            if (row.user_id !== req.user.userId) {
                return res.status(403).json({ error: '无权停止此请求' });
            }

            db.run(
                'UPDATE active_requests SET is_cancelled = 1 WHERE id = ?',
                [requestId],
                (err) => {
                    if (err) {
                        return res.status(500).json({ error: '停止失败' });
                    }
                    console.log(' 停止请求:', requestId);
                    res.json({ success: true, message: '已发送停止信号' });
                }
            );
        }
    );
});

app.post('/api/chat/interject', authenticateToken, (req, res) => {
    const { requestId, message } = req.body || {};
    const content = normalizeStreamingInterjection(message);

    if (!requestId) {
        return res.status(400).json({ error: '缺少requestId' });
    }
    if (!content) {
        return res.status(400).json({ error: '插话内容不能为空' });
    }

    db.get(
        'SELECT user_id, session_id FROM active_requests WHERE id = ?',
        [requestId],
        (err, row) => {
            if (err || !row) {
                return res.status(404).json({ error: '请求不存在或已结束' });
            }

            if (row.user_id !== req.user.userId) {
                return res.status(403).json({ error: '无权向此请求插话' });
            }

            const item = pushRequestInterjection(requestId, content, req.user.userId);
            const sessionId = row.session_id && row.session_id !== 'anonymous' ? row.session_id : null;
            if (!sessionId) {
                return res.json({ success: true, item });
            }

            db.run(
                'UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                [sessionId],
                (updateErr) => {
                    if (updateErr) {
                        console.warn(` 更新讨论插话会话时间失败，但已进入当前研究上下文: ${updateErr.message}`);
                    }
                    res.json({
                        success: true,
                        item,
                        persisted: false,
                        mode: 'research_trace'
                    });
                }
            );
        }
    );
});

// ==================== VIP 会员系统 ====================

// 会员配置
const DAILY_CHECKIN_POINTS = 20;
const MONTHLY_REDEEM_CHECKIN_DAYS = 28;

const MEMBERSHIP_CONFIG = {
    free: { checkinPoints: DAILY_CHECKIN_POINTS },
    Pro: { redeemCost: DAILY_CHECKIN_POINTS * MONTHLY_REDEEM_CHECKIN_DAYS, durationDays: 30 },
    MAX: { redeemCost: 6000, durationDays: 30 }
};

const USER_TASK_REWARDS = {
    pwaInstall: { key: 'pwa_install', points: 300 },
    inviteUser: { keyPrefix: 'invite_user:', points: 600 },
    inviteeUser: { keyPrefix: 'invitee_user:', points: 600 },
    bookmarkDomain: { key: 'bookmark_domain', points: 100 }
};

const NEW_USER_WELCOME_POINTS = 200;

function dbGetAsync(query, params = []) {
    return new Promise((resolve, reject) => {
        db.get(query, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

function dbAllAsync(query, params = []) {
    return new Promise((resolve, reject) => {
        db.all(query, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
        });
    });
}

function dbRunAsync(query, params = []) {
    return new Promise((resolve, reject) => {
        db.run(query, params, function (err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}

function buildEmailCodeMessage({ purpose, code }) {
    const brand = BRAND_TITLE || 'RAI';
    const safeBrand = escapeEmailHtml(brand);
    const safeCode = escapeEmailHtml(code);
    const purposeLabel = purpose === 'register'
        ? '验证注册邮箱'
        : purpose === 'password_reset'
            ? '重置密码'
            : '验证码登录';
    const subject = `${brand} ${purposeLabel}验证码`;
    const intro = purpose === 'register'
        ? `你正在创建 ${brand} 账号，请输入下面的验证码完成邮箱验证。`
        : purpose === 'password_reset'
            ? `你正在重置 ${brand} 密码，请输入下面的验证码继续。`
            : `你正在使用邮箱验证码登录 ${brand}。`;
    const minutes = Math.max(1, Math.round(EMAIL_CODE_TTL_MS / 60000));
    const html = [
        '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;line-height:1.6;color:#111827;padding:24px">',
        `<h2 style="margin:0 0 12px">${safeBrand}</h2>`,
        `<p style="margin:0 0 18px">${escapeEmailHtml(intro)}</p>`,
        `<div style="font-size:32px;font-weight:700;letter-spacing:0.18em;padding:14px 18px;background:#f3f4f6;border-radius:12px;display:inline-block">${safeCode}</div>`,
        `<p style="margin:18px 0 0;color:#6b7280;font-size:14px">验证码 ${minutes} 分钟内有效。若不是你本人操作，可以忽略这封邮件。</p>`,
        '</div>'
    ].join('');
    const text = `${brand}\n\n${intro}\n\n验证码: ${code}\n\n验证码 ${minutes} 分钟内有效。若不是你本人操作，可以忽略这封邮件。`;
    return { subject, html, text };
}

function hashPendingEmailChangeCode({ userId, email, code }) {
    const normalizedCode = normalizeEmailCodeInput(code);
    return crypto
        .createHmac('sha256', JWT_SECRET)
        .update(`${Number(userId) || 0}:email_change:${normalizeEmailForAuth(email)}:${normalizedCode}`)
        .digest('hex');
}

function hashPendingEmailCurrentCode({ userId, currentEmail, pendingEmail, code }) {
    const normalizedCode = normalizeEmailCodeInput(code);
    return crypto
        .createHmac('sha256', JWT_SECRET)
        .update(`${Number(userId) || 0}:email_change_current:${normalizeEmailForAuth(currentEmail)}:${normalizeEmailForAuth(pendingEmail)}:${normalizedCode}`)
        .digest('hex');
}

function buildEmailChangeCodeMessage({ email, code, currentEmail = '', kind = 'new' }) {
    const brand = BRAND_TITLE || 'RAI';
    const safeBrand = escapeEmailHtml(brand);
    const safeCode = escapeEmailHtml(code);
    const safeEmail = escapeEmailHtml(email);
    const safeCurrentEmail = escapeEmailHtml(currentEmail);
    const minutes = Math.max(1, Math.round(EMAIL_CODE_TTL_MS / 60000));
    const isCurrent = kind === 'current';
    const subject = isCurrent ? `${brand} 修改邮箱旧邮箱验证码` : `${brand} 修改邮箱新邮箱验证码`;
    const intro = isCurrent
        ? `你正在把 ${brand} 登录邮箱从 ${currentEmail} 改为 ${email}，请输入下面的旧邮箱验证码确认这是你本人操作。`
        : `你正在把 ${brand} 登录邮箱改为 ${email}，请输入下面的新邮箱验证码确认这个邮箱可用。`;
    const html = [
        '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;line-height:1.6;color:#111827;padding:24px">',
        `<h2 style="margin:0 0 12px">${safeBrand}</h2>`,
        isCurrent
            ? `<p style="margin:0 0 18px">你正在把登录邮箱从 <strong>${safeCurrentEmail}</strong> 改为 <strong>${safeEmail}</strong>，请输入下面的旧邮箱验证码确认这是你本人操作。</p>`
            : `<p style="margin:0 0 18px">你正在把登录邮箱改为 <strong>${safeEmail}</strong>，请输入下面的新邮箱验证码确认这个邮箱可用。</p>`,
        `<div style="font-size:32px;font-weight:700;letter-spacing:0.18em;padding:14px 18px;background:#f3f4f6;border-radius:12px;display:inline-block">${safeCode}</div>`,
        `<p style="margin:18px 0 0;color:#6b7280;font-size:14px">验证码 ${minutes} 分钟内有效。若不是你本人操作，请立即修改密码并开启二步验证。</p>`,
        '</div>'
    ].join('');
    const text = `${brand}\n\n${intro}\n\n验证码: ${code}\n\n验证码 ${minutes} 分钟内有效。若不是你本人操作，请立即修改密码并开启二步验证。`;
    return { subject, html, text };
}

async function issuePendingEmailChangeCode({ userId, currentEmail, email, req }) {
    const normalizedCurrentEmail = normalizeEmailForAuth(currentEmail);
    const normalizedEmail = normalizeEmailForAuth(email);
    if (!Number.isInteger(Number(userId)) || Number(userId) <= 0 || !isValidEmailForAuth(normalizedCurrentEmail) || !isValidEmailForAuth(normalizedEmail)) {
        throw new Error('invalid_email_change_request');
    }

    const currentCode = generateEmailCode();
    const currentCodeHash = hashPendingEmailCurrentCode({
        userId,
        currentEmail: normalizedCurrentEmail,
        pendingEmail: normalizedEmail,
        code: currentCode
    });
    const expiresAt = Date.now() + EMAIL_CODE_TTL_MS;
    await dbRunAsync(
        `UPDATE users
         SET pending_email = ?,
             pending_email_current_code_hash = ?,
             pending_email_current_verified_at = NULL,
             pending_email_code_hash = NULL,
             pending_email_expires_at = ?
         WHERE id = ?`,
        [normalizedEmail, currentCodeHash, expiresAt, userId]
    );

    const currentMessage = buildEmailChangeCodeMessage({
        email: normalizedEmail,
        currentEmail: normalizedCurrentEmail,
        code: currentCode,
        kind: 'current'
    });
    try {
        await sendResendEmail({
            to: normalizedCurrentEmail,
            subject: currentMessage.subject,
            html: currentMessage.html,
            text: currentMessage.text
        });
    } catch (error) {
        await dbRunAsync(
            `UPDATE users
             SET pending_email = NULL,
                 pending_email_current_code_hash = NULL,
                 pending_email_current_verified_at = NULL,
                 pending_email_code_hash = NULL,
                 pending_email_expires_at = NULL
             WHERE id = ? AND pending_email_current_code_hash = ?`,
            [userId, currentCodeHash]
        ).catch(() => null);
        appendRaiRuntimeReport({
            level: '报错',
            tag: 'email_change_code',
            message: `修改邮箱验证码发送失败: ${error.message}`,
            context: {
                userId,
                currentEmailDomain: String(normalizedCurrentEmail).split('@')[1] || '',
                emailDomain: String(normalizedEmail).split('@')[1] || '',
                code: error.code || null,
                status: error.status || null,
                response: error.response || null
            }
        });
        throw error;
    }

    console.log(` 修改邮箱旧邮箱验证码已发送: userId=${userId}, currentDomain=${normalizedCurrentEmail.split('@')[1] || ''}, pendingDomain=${normalizedEmail.split('@')[1] || ''}`);
    return { pending_email: normalizedEmail, pending_email_expires_at: expiresAt, pending_email_stage: 'current' };
}

async function verifyPendingEmailCurrentCodeAndIssueNewCode({ userId, email = '', currentEmailCode = '', req }) {
    const numericUserId = Number(userId);
    const normalizedEmail = normalizeEmailForAuth(email);
    const normalizedCurrentEmailCode = normalizeEmailCodeInput(currentEmailCode);
    if (!Number.isInteger(numericUserId) || numericUserId <= 0 || !isValidEmailForAuth(normalizedEmail) || !isValidEmailCodeInput(normalizedCurrentEmailCode)) {
        const error = new Error('旧邮箱验证码无效或已过期');
        error.statusCode = 400;
        throw error;
    }

    const newCode = generateEmailCode();
    const newCodeHash = hashPendingEmailChangeCode({ userId: numericUserId, email: normalizedEmail, code: newCode });
    const expiresAt = Date.now() + EMAIL_CODE_TTL_MS;
    let user;

    await dbRunAsync('BEGIN IMMEDIATE TRANSACTION');
    try {
        user = await dbGetAsync(
            `SELECT id, email, pending_email, pending_email_current_code_hash, pending_email_expires_at
             FROM users
             WHERE id = ?`,
            [numericUserId]
        );
        if (!user) {
            const error = new Error('用户不存在');
            error.statusCode = 404;
            throw error;
        }

        const pendingEmail = normalizeEmailForAuth(user.pending_email);
        if (!pendingEmail || pendingEmail !== normalizedEmail) {
            const error = new Error('没有待确认的新邮箱');
            error.statusCode = 400;
            throw error;
        }
        if (Number(user.pending_email_expires_at || 0) <= Date.now()) {
            const error = new Error('旧邮箱验证码无效或已过期');
            error.statusCode = 400;
            throw error;
        }
        const expectedCurrentHash = hashPendingEmailCurrentCode({
            userId: numericUserId,
            currentEmail: user.email,
            pendingEmail,
            code: normalizedCurrentEmailCode
        });
        if (!safeCompareText(expectedCurrentHash, user.pending_email_current_code_hash || '')) {
            const error = new Error('旧邮箱验证码无效或已过期');
            error.statusCode = 400;
            throw error;
        }

        await dbRunAsync(
            `UPDATE users
             SET pending_email_current_verified_at = ?,
                 pending_email_code_hash = ?,
                 pending_email_expires_at = ?
             WHERE id = ?`,
            [Date.now(), newCodeHash, expiresAt, numericUserId]
        );
        await dbRunAsync('COMMIT');
    } catch (error) {
        await dbRunAsync('ROLLBACK').catch(() => null);
        throw error;
    }

    const message = buildEmailChangeCodeMessage({
        email: normalizedEmail,
        currentEmail: normalizeEmailForAuth(user.email),
        code: newCode,
        kind: 'new'
    });
    try {
        await sendResendEmail({
            to: normalizedEmail,
            subject: message.subject,
            html: message.html,
            text: message.text
        });
    } catch (error) {
        await dbRunAsync(
            `UPDATE users
             SET pending_email_code_hash = NULL
             WHERE id = ? AND pending_email_code_hash = ?`,
            [numericUserId, newCodeHash]
        ).catch(() => null);
        appendRaiRuntimeReport({
            level: '报错',
            tag: 'email_change_new_code',
            message: `修改邮箱新邮箱验证码发送失败: ${error.message}`,
            context: {
                userId: numericUserId,
                emailDomain: String(normalizedEmail).split('@')[1] || '',
                code: error.code || null,
                status: error.status || null,
                response: error.response || null
            }
        });
        throw error;
    }

    console.log(` 修改邮箱新邮箱验证码已发送: userId=${numericUserId}, pendingDomain=${normalizedEmail.split('@')[1] || ''}`);
    return { pending_email: normalizedEmail, pending_email_expires_at: expiresAt, pending_email_stage: 'new' };
}

async function verifyPendingEmailChange({ userId, email = '', code = '' }) {
    const numericUserId = Number(userId);
    const normalizedEmail = normalizeEmailForAuth(email);
    const normalizedCode = normalizeEmailCodeInput(code);
    if (!Number.isInteger(numericUserId) || numericUserId <= 0 || !isValidEmailCodeInput(normalizedCode)) {
        const error = new Error('验证码无效或已过期');
        error.statusCode = 400;
        throw error;
    }

    await dbRunAsync('BEGIN IMMEDIATE TRANSACTION');
    try {
        const user = await dbGetAsync(
            `SELECT id, email, username, avatar_url, external_provider, external_uid,
                    pending_email, pending_email_current_verified_at, pending_email_code_hash, pending_email_expires_at
             FROM users
             WHERE id = ?`,
            [numericUserId]
        );
        if (!user) {
            const error = new Error('用户不存在');
            error.statusCode = 404;
            throw error;
        }

        const pendingEmail = normalizeEmailForAuth(user.pending_email);
        if (!pendingEmail || (normalizedEmail && normalizedEmail !== pendingEmail)) {
            const error = new Error('没有待确认的新邮箱');
            error.statusCode = 400;
            throw error;
        }
        if (!isValidEmailForAuth(pendingEmail) || Number(user.pending_email_expires_at || 0) <= Date.now()) {
            const error = new Error('验证码无效或已过期');
            error.statusCode = 400;
            throw error;
        }
        if (!user.pending_email_current_verified_at || !user.pending_email_code_hash) {
            const error = new Error('请先验证旧邮箱验证码');
            error.statusCode = 400;
            throw error;
        }
        const expectedHash = hashPendingEmailChangeCode({
            userId: numericUserId,
            email: pendingEmail,
            code: normalizedCode
        });
        if (!safeCompareText(expectedHash, user.pending_email_code_hash || '')) {
            const error = new Error('新邮箱验证码无效或已过期');
            error.statusCode = 400;
            throw error;
        }

        const duplicate = await dbGetAsync(
            'SELECT id FROM users WHERE LOWER(email) = LOWER(?) AND id != ?',
            [pendingEmail, numericUserId]
        );
        if (duplicate) {
            const error = new Error('该邮箱已被其他账号使用');
            error.statusCode = 409;
            throw error;
        }

        await dbRunAsync(
            `UPDATE users
             SET email = ?,
                 email_verified = 1,
                 email_verified_at = CURRENT_TIMESTAMP,
                 pending_email = NULL,
                 pending_email_current_code_hash = NULL,
                 pending_email_current_verified_at = NULL,
                 pending_email_code_hash = NULL,
                 pending_email_expires_at = NULL
             WHERE id = ?`,
            [pendingEmail, numericUserId]
        );
        await dbRunAsync('COMMIT');

        return {
            ...user,
            email: pendingEmail,
            pending_email: null,
            pending_email_current_code_hash: null,
            pending_email_current_verified_at: null,
            pending_email_code_hash: null,
            pending_email_expires_at: null
        };
    } catch (error) {
        await dbRunAsync('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function sendResendEmail({ to, subject, html, text }) {
    if (!RESEND_API_KEY) {
        const error = new Error('resend_api_key_missing');
        error.code = 'email_service_not_configured';
        throw error;
    }
    if (!RESEND_FROM_EMAIL) {
        const error = new Error('resend_from_email_invalid');
        error.code = 'email_from_invalid';
        error.response = {
            message: 'RESEND_FROM_EMAIL/RAI_EMAIL_FROM must be email@example.com or Name <email@example.com>'
        };
        throw error;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RESEND_TIMEOUT_MS);
    let response;
    try {
        response = await fetch(RESEND_API_URL, {
            method: 'POST',
            signal: controller.signal,
            headers: {
                'Authorization': `Bearer ${RESEND_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                from: RESEND_FROM_EMAIL,
                to,
                subject,
                html,
                text
            })
        });
    } catch (error) {
        if (error?.name === 'AbortError') {
            const timeoutError = new Error('resend_email_timeout');
            timeoutError.code = 'email_timeout';
            throw timeoutError;
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }

    const rawBody = await response.text().catch(() => '');
    let parsedBody = null;
    try {
        parsedBody = rawBody ? JSON.parse(rawBody) : null;
    } catch (error) {
        parsedBody = { raw: rawBody.slice(0, 500) };
    }

	    if (!response.ok) {
	        const error = new Error(`resend_email_failed_${response.status}`);
	        error.status = response.status;
	        error.response = parsedBody;
	        const responseMessage = String(parsedBody?.message || parsedBody?.error || '').trim();
	        if (response.status === 403 && /only send testing emails|verify a domain/i.test(responseMessage)) {
	            error.code = 'resend_testing_domain_restricted';
	        }
	        throw error;
	    }

    return parsedBody || {};
}

async function sendWelcomeEmail({ email, username }) {
    const safeBrand = escapeEmailHtml(BRAND_TITLE || BRAND_NAME);
    const displayName = escapeEmailHtml(username || email || '');
    const subject = `欢迎来到 ${BRAND_TITLE || BRAND_NAME} 🎉`;
    const html = [
        '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;line-height:1.7;color:#111827;max-width:560px;margin:0 auto;padding:24px">',
        `<h2 style="margin:0 0 12px">欢迎，${displayName}！</h2>`,
        `<p style="margin:0 0 14px">感谢注册 <strong>${safeBrand}</strong>。账号已创建成功，我们已为你发放 <strong>200 点数</strong>，可以直接开始对话。</p>`,
        '<h3 style="margin:18px 0 8px;font-size:16px">你可以试试</h3>',
        '<ul style="margin:0 0 14px;padding-left:20px;color:#374151">',
        '<li>用「智能模型」日常问答、写作、写代码</li>',
        '<li>开启「研究模式」让多个子模型辩论，得到更全面的答案</li>',
        '<li>上传图片 / 文档，AI 帮你读图、读表、读 PDF</li>',
        '<li>每日签到领点数，完成小任务额外得奖励</li>',
        '</ul>',
        '<p style="margin:0 0 14px">遇到问题随时在设置里反馈，我们会持续更新。</p>',
        `<p style="margin:18px 0 0;color:#6b7280;font-size:13px">— ${safeBrand} 团队</p>`,
        '</div>'
    ].join('');
    const text = `欢迎来到 ${BRAND_TITLE || BRAND_NAME}！\n\n你的账号已创建成功，我们已为你发放 200 点数，可以直接开始对话。\n\n你可以试试：\n- 智能模型日常问答、写作、写代码\n- 研究模式多模型辩论\n- 上传图片 / 文档\n- 每日签到领点数\n\n— ${BRAND_TITLE || BRAND_NAME} 团队`;
    return sendResendEmail({ to: email, subject, html, text });
}

async function cleanupEmailCodes() {
    const now = Date.now();
    const consumedBefore = now - (24 * 60 * 60 * 1000);
    await dbRunAsync(
        'DELETE FROM auth_email_codes WHERE expires_at < ? OR (consumed_at IS NOT NULL AND consumed_at < ?)',
        [now, consumedBefore]
    ).catch((error) => {
        console.warn(' 邮箱验证码清理失败:', error.message);
    });
}

async function issueEmailCode({ email, userId = null, purpose, metadata = {}, req }) {
    const normalizedEmail = normalizeEmailForAuth(email);
    if (!isValidEmailForAuth(normalizedEmail) || !EMAIL_CODE_PURPOSES.has(purpose)) {
        throw new Error('invalid_email_code_request');
    }

    await cleanupEmailCodes();
    const code = generateEmailCode();
    const now = Date.now();
    const codeHash = hashEmailCode({ email: normalizedEmail, purpose, code });
    const safeMetadata = metadata && typeof metadata === 'object' ? metadata : {};

    await dbRunAsync(
        `UPDATE auth_email_codes
         SET consumed_at = ?
         WHERE LOWER(email) = LOWER(?) AND purpose = ? AND consumed_at IS NULL`,
        [now, normalizedEmail, purpose]
    );

    await dbRunAsync(
        `INSERT INTO auth_email_codes
         (email, user_id, purpose, code_hash, attempts, metadata, created_at, expires_at, request_ip, user_agent)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
        [
            normalizedEmail,
            userId || null,
            purpose,
            codeHash,
            JSON.stringify(safeMetadata),
            now,
            now + EMAIL_CODE_TTL_MS,
            req?.ip || '',
            String(req?.headers?.['user-agent'] || '').slice(0, 500)
        ]
    );

    const message = buildEmailCodeMessage({ purpose, code });
    await sendResendEmail({
        to: normalizedEmail,
        subject: message.subject,
        html: message.html,
        text: message.text
    });
}

async function verifyAndConsumeEmailCode({ email, purpose, code, userId = null }) {
    const normalizedEmail = normalizeEmailForAuth(email);
    const normalizedCode = normalizeEmailCodeInput(code);
    if (!isValidEmailForAuth(normalizedEmail) || !EMAIL_CODE_PURPOSES.has(purpose) || !isValidEmailCodeInput(normalizedCode)) {
        return { ok: false, error: '验证码无效或已过期' };
    }

    await cleanupEmailCodes();
    const params = [normalizedEmail, purpose, Date.now()];
    let userFilter = '';
    if (userId) {
        userFilter = ' AND (user_id = ? OR user_id IS NULL)';
        params.push(userId);
    }

    const row = await dbGetAsync(
        `SELECT *
         FROM auth_email_codes
         WHERE LOWER(email) = LOWER(?)
           AND purpose = ?
           AND consumed_at IS NULL
           AND expires_at > ?
           ${userFilter}
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
        params
    );

    if (!row) {
        return { ok: false, error: '验证码无效或已过期' };
    }

    if (Number(row.attempts || 0) >= EMAIL_CODE_MAX_ATTEMPTS) {
        await dbRunAsync('UPDATE auth_email_codes SET consumed_at = ? WHERE id = ?', [Date.now(), row.id]);
        return { ok: false, error: '验证码尝试次数过多，请重新获取' };
    }

    const expectedHash = hashEmailCode({ email: normalizedEmail, purpose, code: normalizedCode });
    if (!safeCompareText(expectedHash, row.code_hash)) {
        await dbRunAsync('UPDATE auth_email_codes SET attempts = attempts + 1 WHERE id = ?', [row.id]);
        return { ok: false, error: '验证码无效或已过期' };
    }

    await dbRunAsync('UPDATE auth_email_codes SET consumed_at = ? WHERE id = ?', [Date.now(), row.id]);

    let metadata = {};
    try {
        metadata = row.metadata ? JSON.parse(row.metadata) : {};
    } catch (error) {
        metadata = {};
    }

    return { ok: true, row, metadata };
}

async function sendEmailCodeOrReport(args) {
    try {
        await issueEmailCode(args);
        return { ok: true };
    } catch (error) {
        appendRaiRuntimeReport({
            level: '报错',
            tag: 'email_auth',
            message: `邮件验证码发送失败: ${error.message}`,
	            context: {
	                purpose: args?.purpose,
	                emailDomain: String(args?.email || '').split('@')[1] || '',
	                code: error.code || null,
	                status: error.status || null,
	                response: error.response || null
	            }
        });
	    return { ok: false, error };
	}
}

function isResendTestingRestrictionError(error) {
    if (!error) return false;
    if (error.code === 'resend_testing_domain_restricted') return true;
    const responseMessage = String(error.response?.message || error.response?.error || '').trim();
    return Number(error.status || 0) === 403
        && /only send testing emails|verify a domain/i.test(responseMessage);
}

function shouldBypassResendTestingRestriction(error) {
    return ALLOW_RESEND_TEST_MODE_EMAIL_BYPASS && isResendTestingRestrictionError(error);
}

async function getAdminRuntimeSettings() {
    const settings = { ...ADMIN_RUNTIME_LIMIT_DEFAULTS };
    try {
        const rows = await dbAllAsync('SELECT setting_key, setting_value FROM admin_runtime_settings');
        for (const row of rows) {
            if (!Object.prototype.hasOwnProperty.call(settings, row.setting_key)) continue;
            const defaultValue = ADMIN_RUNTIME_LIMIT_DEFAULTS[row.setting_key];
            if (defaultValue === 0 || defaultValue === 1) {
                settings[row.setting_key] = parseBoundedInteger(row.setting_value, defaultValue, 0, 1);
            } else {
                settings[row.setting_key] = parseBoundedInteger(row.setting_value, defaultValue, 0, 100000);
            }
        }
    } catch (error) {
        console.warn(' 读取管理员运行限制失败，使用默认值:', error.message);
    }
    return settings;
}

async function setAdminRuntimeSettings(patch = {}) {
    const allowedRanges = {
        chat_per_minute: [0, 1000],
        chat_per_5h: [0, 10000],
        chat_per_week: [0, 100000],
        concurrent_requests: [1, 20],
        upload_per_minute: [0, 1000],
        upload_max_file_mb: [1, 50],
        upload_user_total_mb: [0, 102400],
        upload_user_max_files: [0, 100000],
        pwa_reward_enabled: [0, 1],
        pwa_reward_min_account_age_minutes: [0, 10080],
        invite_reward_immediate_enabled: [0, 1]
    };
    const saved = {};
    for (const [key, rawValue] of Object.entries(patch || {})) {
        if (!Object.prototype.hasOwnProperty.call(allowedRanges, key)) continue;
        const [min, max] = allowedRanges[key];
        const value = parseBoundedInteger(rawValue, ADMIN_RUNTIME_LIMIT_DEFAULTS[key], min, max);
        await dbRunAsync(
            `INSERT INTO admin_runtime_settings (setting_key, setting_value, updated_at)
             VALUES (?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(setting_key) DO UPDATE SET
                setting_value = excluded.setting_value,
                updated_at = CURRENT_TIMESTAMP`,
            [key, String(value)]
        );
        saved[key] = value;
    }
    return { ...(await getAdminRuntimeSettings()), ...saved };
}

function buildTaskMetadata(req, metadata = {}) {
    return JSON.stringify({
        ...metadata,
        userAgent: String(req?.headers?.['user-agent'] || '').slice(0, 300),
        ip: String(req?.ip || req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim().slice(0, 80)
    });
}

function normalizeReferralUserId(value) {
    const text = String(value || '').trim();
    if (!/^\d{1,12}$/.test(text)) return null;
    const id = Number.parseInt(text, 10);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function getUserTaskSnapshot(userId) {
    const rows = await dbAllAsync(
        'SELECT task_key, points, completed_at, metadata FROM user_task_rewards WHERE user_id = ? ORDER BY completed_at ASC',
        [userId]
    );
    const pwaInstall = rows.find((row) => row.task_key === USER_TASK_REWARDS.pwaInstall.key);
    const inviteRows = rows.filter((row) => String(row.task_key || '').startsWith(USER_TASK_REWARDS.inviteUser.keyPrefix));
    const invitePoints = inviteRows.reduce((sum, row) => sum + Number(row.points || 0), 0);
    const inviteeRows = rows.filter((row) => String(row.task_key || '').startsWith(USER_TASK_REWARDS.inviteeUser.keyPrefix));
    const inviteePoints = inviteeRows.reduce((sum, row) => sum + Number(row.points || 0), 0);
    const bookmarkDomain = rows.find((row) => row.task_key === USER_TASK_REWARDS.bookmarkDomain.key);

    return {
        pwaInstall: {
            key: USER_TASK_REWARDS.pwaInstall.key,
            rewardPoints: USER_TASK_REWARDS.pwaInstall.points,
            completed: Boolean(pwaInstall),
            completedAt: pwaInstall?.completed_at || null
        },
        inviteUser: {
            key: 'invite_user',
            rewardPoints: USER_TASK_REWARDS.inviteUser.points,
            completed: inviteRows.length > 0,
            completedAt: inviteRows[0]?.completed_at || null,
            completedCount: inviteRows.length,
            totalRewardPoints: invitePoints
        },
        inviteeUser: {
            key: 'invitee_user',
            rewardPoints: USER_TASK_REWARDS.inviteeUser.points,
            completed: inviteeRows.length > 0,
            completedAt: inviteeRows[0]?.completed_at || null,
            completedCount: inviteeRows.length,
            totalRewardPoints: inviteePoints
        },
        bookmarkDomain: {
            key: USER_TASK_REWARDS.bookmarkDomain.key,
            rewardPoints: USER_TASK_REWARDS.bookmarkDomain.points,
            completed: Boolean(bookmarkDomain),
            completedAt: bookmarkDomain?.completed_at || null
        }
    };
}

async function awardUserTaskPoints({ userId, taskKey, points, metadata = null }) {
    let inTransaction = false;
    try {
        await dbRunAsync('BEGIN IMMEDIATE TRANSACTION');
        inTransaction = true;

        const insertResult = await dbRunAsync(
            `INSERT OR IGNORE INTO user_task_rewards (user_id, task_key, points, metadata)
             VALUES (?, ?, ?, ?)`,
            [userId, taskKey, points, metadata]
        );
        const awarded = Number(insertResult?.changes || 0) > 0;

        if (awarded) {
            await dbRunAsync(
                'UPDATE users SET points = COALESCE(points, 0) + ? WHERE id = ?',
                [points, userId]
            );
        }

        await dbRunAsync('COMMIT');
        inTransaction = false;
        return { awarded, pointsGained: awarded ? points : 0 };
    } catch (error) {
        if (inTransaction) {
            try {
                await dbRunAsync('ROLLBACK');
            } catch (rollbackError) {
                console.error(' 任务积分回滚失败:', rollbackError);
            }
        }
        throw error;
    }
}

async function awardInviteReferralIfValid(referrerId, invitedUserId, req) {
    const normalizedReferrerId = normalizeReferralUserId(referrerId);
    if (!normalizedReferrerId || normalizedReferrerId === invitedUserId) {
        return { awarded: false, pointsGained: 0, reason: 'invalid_referrer' };
    }

    const settings = await getAdminRuntimeSettings();
    if (Number(settings.invite_reward_immediate_enabled || 0) !== 1) {
        console.warn(` 邀请奖励已进入待结算: referrer=${normalizedReferrerId}, invited=${invitedUserId}`);
        return { awarded: false, pointsGained: 0, pending: true, reason: 'invite_reward_pending_review' };
    }

    const referrer = await dbGetAsync('SELECT id FROM users WHERE id = ?', [normalizedReferrerId]);
    if (!referrer) {
        return { awarded: false, pointsGained: 0, reason: 'referrer_not_found' };
    }

    const referrerReward = await awardUserTaskPoints({
        userId: normalizedReferrerId,
        taskKey: `${USER_TASK_REWARDS.inviteUser.keyPrefix}${invitedUserId}`,
        points: USER_TASK_REWARDS.inviteUser.points,
        metadata: buildTaskMetadata(req, {
            invitedUserId,
            source: 'register_referral_referrer'
        })
    });

    const inviteeReward = await awardUserTaskPoints({
        userId: invitedUserId,
        taskKey: `${USER_TASK_REWARDS.inviteeUser.keyPrefix}${normalizedReferrerId}`,
        points: USER_TASK_REWARDS.inviteeUser.points,
        metadata: buildTaskMetadata(req, {
            referrerId: normalizedReferrerId,
            source: 'register_referral_invitee'
        })
    });

    return {
        awarded: Boolean(referrerReward.awarded || inviteeReward.awarded),
        pointsGained: Number(referrerReward.pointsGained || 0),
        inviteePointsGained: Number(inviteeReward.pointsGained || 0),
        referrerReward,
        inviteeReward
    };
}

const ANNOUNCEMENT_DELIVERY_MODES = ['popup', 'toast', 'silent'];

function normalizeAnnouncementLanguage(value = '') {
    const raw = String(value || '').trim().toLowerCase();
    return raw.startsWith('en') ? 'en' : 'zh-CN';
}

function serializeAnnouncement(row, options = {}) {
    if (!row) return null;
    const language = normalizeAnnouncementLanguage(options.language);
    const localizedTitle = language === 'en' && row.title_en ? row.title_en : row.title;
    const localizedBody = language === 'en' && row.body_en ? row.body_en : row.body;
    return {
        id: row.id,
        title: localizedTitle || '',
        body: localizedBody || '',
        titleEn: row.title_en || '',
        bodyEn: row.body_en || '',
        deliveryMode: ANNOUNCEMENT_DELIVERY_MODES.includes(row.delivery_mode) ? row.delivery_mode : 'silent',
        startAt: row.start_at || null,
        endAt: row.end_at || null,
        enabled: Number(row.enabled || 0) === 1,
        createdAt: row.created_at || null,
        updatedAt: row.updated_at || null
    };
}

function normalizeIsoTimestamp(value) {
    if (value === undefined || value === null || value === '') return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString();
}

function normalizeAnnouncementInput(body = {}) {
    const title = String(body.title || '').trim();
    if (!title) {
        return { error: '公告标题不能为空' };
    }
    if (title.length > 200) {
        return { error: '公告标题过长（上限 200 字符）' };
    }

    const titleEn = String(body.titleEn ?? body.title_en ?? '').trim();
    if (titleEn.length > 200) {
        return { error: '英文公告标题过长（上限 200 字符）' };
    }

    let text = String(body.body || '');
    if (text.length > 4000) {
        return { error: '公告正文过长（上限 4000 字符）' };
    }

    let bodyEn = String(body.bodyEn ?? body.body_en ?? '');
    if (bodyEn.length > 4000) {
        return { error: '英文公告正文过长（上限 4000 字符）' };
    }

    const rawMode = String(body.deliveryMode || body.delivery_mode || 'silent');
    const deliveryMode = ANNOUNCEMENT_DELIVERY_MODES.includes(rawMode) ? rawMode : 'silent';

    const startAt = normalizeIsoTimestamp(body.startAt ?? body.start_at);
    const endAt = normalizeIsoTimestamp(body.endAt ?? body.end_at);
    if (startAt && endAt && startAt > endAt) {
        return { error: '公告开始时间不能晚于结束时间' };
    }

    const enabledRaw = body.enabled;
    const enabled = enabledRaw === false || enabledRaw === 0 || enabledRaw === '0' ? 0 : 1;

    return { value: { title, body: text, titleEn: titleEn || null, bodyEn: bodyEn || null, deliveryMode, startAt, endAt, enabled } };
}

function normalizeAdminModelId(modelId) {
    const normalized = normalizeIncomingModelId(modelId);
    return PUBLIC_MODEL_IDS.includes(normalized) ? normalized : '';
}

async function getDisabledModelSet({ forceRefresh = false } = {}) {
    const now = Date.now();
    if (!forceRefresh && modelAvailabilityCache.loadedAt && now - modelAvailabilityCache.loadedAt < MODEL_DISABLED_CACHE_TTL_MS) {
        return modelAvailabilityCache.disabled;
    }

    const rows = await dbAllAsync(
        'SELECT model_id FROM model_visibility WHERE enabled = 0'
    );
    modelAvailabilityCache = {
        loadedAt: now,
        disabled: new Set(rows.map((row) => normalizeAdminModelId(row.model_id)).filter(Boolean))
    };
    return modelAvailabilityCache.disabled;
}

async function isPublicModelDisabled(modelId) {
    const normalized = normalizeAdminModelId(modelId);
    if (!normalized) return false;
    const disabled = await getDisabledModelSet();
    return disabled.has(normalized);
}

function isRuntimeConfiguredModel(modelId = '') {
    const normalized = normalizeIncomingModelId(modelId);
    const routing = MODEL_ROUTING[normalized];
    const provider = routing ? API_PROVIDERS[routing.provider] : null;
    return !!(routing && provider?.apiKey);
}

async function resolveVisibleAutoModel() {
    const disabled = await getDisabledModelSet();
    const preferred = AUTO_MODEL_PREFERENCE.find((modelId) => !disabled.has(modelId) && isRuntimeConfiguredModel(modelId));
    return preferred || findAvailableRuntimeFallbackModelId('') || 'openrouter-free';
}

async function resolveVisibleAutoMultimodalModel() {
    const disabled = await getDisabledModelSet();
    return AUTO_MULTIMODAL_MODEL_PREFERENCE.find((modelId) => !disabled.has(modelId) && isRuntimeConfiguredModel(modelId))
        || await resolveVisibleAutoModel();
}

async function getModelVisibilityPayload({ forceRefresh = false } = {}) {
    const disabled = await getDisabledModelSet({ forceRefresh });
    return ADMIN_MODEL_CATALOG.map((model) => ({
        ...model,
        enabled: !disabled.has(model.id)
    }));
}

app.post('/api/messages/:messageId/feedback', authenticateToken, async (req, res) => {
    try {
        const messageId = Number.parseInt(req.params.messageId, 10);
        const rating = String(req.body?.rating || '').trim();
        const comment = String(req.body?.comment || '').trim();

        if (!Number.isInteger(messageId) || messageId <= 0) {
            return res.status(400).json({ error: '无效的消息ID' });
        }

        if (!['up', 'down'].includes(rating)) {
            return res.status(400).json({ error: '无效的反馈类型' });
        }

        if (comment.length > 1000) {
            return res.status(400).json({ error: '反馈内容不能超过1000字' });
        }

        const message = await dbGetAsync(`
            SELECT m.id, m.session_id, m.role, s.user_id
            FROM messages m
            JOIN sessions s ON m.session_id = s.id
            WHERE m.id = ? AND s.user_id = ?
        `, [messageId, req.user.userId]);

        if (!message) {
            return res.status(404).json({ error: '消息不存在' });
        }

        if (message.role !== 'assistant') {
            return res.status(400).json({ error: '只能反馈AI回复' });
        }

        await dbRunAsync(`
            INSERT INTO message_feedback (message_id, session_id, user_id, rating, comment, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id, message_id) DO UPDATE SET
                rating = excluded.rating,
                comment = excluded.comment,
                updated_at = CURRENT_TIMESTAMP
        `, [message.id, message.session_id, req.user.userId, rating, comment || null]);

        res.json({
            success: true,
            feedback: {
                messageId: message.id,
                rating,
                comment
            }
        });
    } catch (error) {
        console.error('保存消息反馈失败:', error);
        res.status(500).json({ error: '保存反馈失败' });
    }
});

app.get('/api/model-availability', async (req, res) => {
    try {
        const models = await getModelVisibilityPayload();
        res.json({
            models,
            disabledModels: models.filter((model) => !model.enabled).map((model) => model.id)
        });
    } catch (error) {
        console.error(' 获取模型可见性失败:', error);
        res.status(500).json({ error: '获取模型可见性失败' });
    }
});

let ensureSessionKindColumnPromise = null;
let ensureFlowSessionIdColumnPromise = null;

async function ensureColumnExists(tableName, columnName, alterSql) {
    const columns = await dbAllAsync(`PRAGMA table_info(${tableName})`);
    if (columns.some((column) => String(column?.name || '').trim() === columnName)) {
        return false;
    }

    try {
        await dbRunAsync(alterSql);
        return true;
    } catch (error) {
        if (String(error?.message || '').includes('duplicate column')) {
            return false;
        }
        throw error;
    }
}

async function ensureSessionKindColumn() {
    if (!ensureSessionKindColumnPromise) {
        ensureSessionKindColumnPromise = (async () => {
            await ensureColumnExists('sessions', 'session_kind', `ALTER TABLE sessions ADD COLUMN session_kind TEXT DEFAULT 'chat'`);
            await dbRunAsync(`CREATE INDEX IF NOT EXISTS idx_sessions_user_kind_updated ON sessions(user_id, session_kind, is_archived, updated_at DESC)`);
        })().catch((error) => {
            ensureSessionKindColumnPromise = null;
            throw error;
        });
    }

    return ensureSessionKindColumnPromise;
}

async function ensureFlowSessionIdColumn() {
    if (!ensureFlowSessionIdColumnPromise) {
        ensureFlowSessionIdColumnPromise = ensureColumnExists('flows', 'session_id', `ALTER TABLE flows ADD COLUMN session_id TEXT`).catch((error) => {
            ensureFlowSessionIdColumnPromise = null;
            throw error;
        });
    }

    return ensureFlowSessionIdColumnPromise;
}

async function ensureChatFlowSchemaColumns() {
    await ensureSessionKindColumn();
    await ensureFlowSessionIdColumn();
}

function getTodayDateString() {
    return new Date().toISOString().split('T')[0];
}

function normalizePromptTimeContext(raw) {
    if (!raw || typeof raw !== 'object') return null;

    const datetime = typeof raw.datetime === 'string' ? raw.datetime.trim() : '';
    if (!datetime) return null;

    const timezone = typeof raw.timezone === 'string' && raw.timezone.trim()
        ? raw.timezone.trim()
        : 'unknown';
    const locale = typeof raw.locale === 'string' && raw.locale.trim()
        ? raw.locale.trim()
        : 'unknown';
    const timeOfDay = typeof raw.timeOfDay === 'string' && raw.timeOfDay.trim()
        ? raw.timeOfDay.trim()
        : 'unknown';
    const hour = Number(raw.hour);

    return {
        datetime,
        timezone,
        locale,
        timeOfDay,
        hour: Number.isFinite(hour) ? hour : null
    };
}

function stripInlinePromptTimeHint(content = '') {
    return String(content || '')
        .replace(/\n{0,2}\[(?:当前时间|Current time)[^\]]*(?:不要把回答中心放在时间上|do not center the answer on time)[。.]?\]/i, '')
        .trim();
}

function buildPromptContextTrace(promptTimeContext) {
    if (!promptTimeContext) return null;

    return {
        prompt_context: {
            injection: 'per_request_datetime',
            injectedAt: new Date().toISOString(),
            requestTimeContext: promptTimeContext
        }
    };
}

function sanitizePromptUserField(value) {
    return String(value || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200);
}

async function getPromptUserProfile(userId, fallbackEmail = '') {
    const user = userId
        ? await dbGetAsync('SELECT email, username FROM users WHERE id = ?', [userId])
        : null;
    const email = sanitizePromptUserField(user?.email || fallbackEmail);
    const username = sanitizePromptUserField(
        user?.username || (email.includes('@') ? email.split('@')[0] : '')
    );

    return {
        email,
        username
    };
}

function buildUserIdentityPrompt(profile) {
    if (!profile || typeof profile !== 'object') return '';

    const username = sanitizePromptUserField(profile.username);
    const email = sanitizePromptUserField(profile.email);
    const lines = [];

    if (username) lines.push(`- 用户名: ${username}`);
    if (email) lines.push(`- 邮箱: ${email}`);
    if (lines.length === 0) return '';

    return [
        '[当前登录用户信息]',
        ...lines,
        '以上信息来自当前已登录账号，可用于帮助你理解用户背景并提供更贴合的回答；除非用户明确要求，否则不要主动复述或暴露这些信息。'
    ].join('\n');
}

function sanitizeMemoryContent(value) {
    return String(value || '')
        .normalize('NFKC')
        .replace(/\s+/g, ' ')
        .replace(/[\u0000-\u001F\u007F]/g, '')
        .trim()
        .slice(0, MEMORY_CONTENT_MAX_LENGTH);
}

function normalizeMemoryCategory(category) {
    const normalized = String(category || '').trim().toLowerCase().replace(/[^a-z_]/g, '');
    return MEMORY_CATEGORIES.has(normalized) ? normalized : 'other';
}

function normalizeMemoryKeyText(value) {
    return String(value || '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[\s，。,.!?！？:：;；'"“”‘’、()/\\[\]{}<>]+/g, '')
        .trim();
}

function buildMemoryKey(category, content) {
    const normalizedCategory = normalizeMemoryCategory(category);
    const normalizedContent = normalizeMemoryKeyText(content).slice(0, MEMORY_KEY_MAX_LENGTH);
    if (!normalizedContent) return '';
    const digest = crypto.createHash('sha1').update(`${normalizedCategory}:${normalizedContent}`).digest('hex').slice(0, 14);
    return `${normalizedCategory}:${digest}`;
}

function isLongMemoryEnabledValue(value) {
    if (value === undefined || value === null || value === '') return LONG_MEMORY_DEFAULT_ENABLED;
    return Number(value) === 1 || value === true || String(value).toLowerCase() === 'true';
}

function parseShortMemoryTitles(value) {
    try {
        const parsed = typeof value === 'string' && value.trim()
            ? JSON.parse(value)
            : [];
        return Array.isArray(parsed)
            ? parsed.map((title) => sanitizeMemoryContent(title)).filter(Boolean).slice(0, RECENT_TITLE_MEMORY_LIMIT)
            : [];
    } catch {
        return [];
    }
}

function isMemoryOptedInConfig(row) {
    if (!row) return false;
    return isLongMemoryEnabledValue(row.long_memory_enabled) && !!row.long_memory_opted_in_at;
}

async function isUserLongMemoryEnabled(userId) {
    const row = await dbGetAsync('SELECT long_memory_enabled, long_memory_opted_in_at FROM user_configs WHERE user_id = ?', [userId])
        .catch(() => null);
    if (!row) return LONG_MEMORY_DEFAULT_ENABLED;
    return isMemoryOptedInConfig(row);
}

async function listActiveUserMemories(userId, limit = 80) {
    return dbAllAsync(
        `SELECT id, category, content, confidence, source_session_id, source_message_id, created_at, updated_at
         FROM user_memories
         WHERE user_id = ? AND deleted_at IS NULL
         ORDER BY updated_at DESC, id DESC
         LIMIT ?`,
        [userId, Math.max(1, Math.min(Number(limit) || 80, 200))]
    );
}

async function getRecentConversationTitlesForMemory(userId, limit = RECENT_TITLE_MEMORY_LIMIT) {
    const rows = await dbAllAsync(
        `SELECT title
         FROM sessions
         WHERE user_id = ?
           AND is_archived = 0
           AND COALESCE(session_kind, 'chat') = 'chat'
           AND title IS NOT NULL
           AND TRIM(title) != ''
         ORDER BY updated_at DESC
         LIMIT ?`,
        [userId, Math.max(1, Math.min(Number(limit) || RECENT_TITLE_MEMORY_LIMIT, 20))]
    );
    const seen = new Set();
    return rows
        .map((row) => sanitizeMemoryContent(row.title))
        .filter((title) => title && !GENERIC_SESSION_TITLE_RE.test(title))
        .filter((title) => {
            const key = normalizeMemoryKeyText(title);
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .slice(0, limit);
}

async function refreshUserShortTermMemorySnapshot(userId) {
    const titles = await getRecentConversationTitlesForMemory(userId, RECENT_TITLE_MEMORY_LIMIT);
    await dbRunAsync(
        `UPDATE user_configs
         SET short_memory_titles = ?, short_memory_updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ?`,
        [JSON.stringify(titles), userId]
    );
    return titles;
}

async function setUserLongMemoryEnabled(userId, enabled) {
    await dbRunAsync(
        `INSERT OR IGNORE INTO user_configs (user_id, long_memory_enabled)
         VALUES (?, 0)`,
        [userId]
    );

    if (!enabled) {
        await dbRunAsync(
            `UPDATE user_configs
             SET long_memory_enabled = 0
             WHERE user_id = ?`,
            [userId]
        );
        const row = await dbGetAsync(
            'SELECT short_memory_titles FROM user_configs WHERE user_id = ?',
            [userId]
        ).catch(() => null);
        return {
            enabled: false,
            shortTermMemory: parseShortMemoryTitles(row?.short_memory_titles),
            memories: []
        };
    }

    await dbRunAsync(
        `UPDATE user_configs
         SET long_memory_enabled = 1,
             long_memory_opted_in_at = CURRENT_TIMESTAMP
         WHERE user_id = ?`,
        [userId]
    );
    const shortTermMemory = await refreshUserShortTermMemorySnapshot(userId);
    const memories = await listActiveUserMemories(userId, 200);
    return {
        enabled: true,
        shortTermMemory,
        memories
    };
}

async function getRecentSessionMessagesForMemory(userId, sessionId, limit = MEMORY_CONTEXT_MESSAGE_LIMIT) {
    if (!sessionId) return [];
    const rows = await dbAllAsync(
        `SELECT m.id, m.role, m.content, m.created_at
         FROM messages m
         JOIN sessions s ON s.id = m.session_id
         WHERE m.session_id = ?
           AND s.user_id = ?
           AND COALESCE(s.session_kind, 'chat') = 'chat'
           AND m.role IN ('user', 'assistant')
         ORDER BY m.created_at DESC, m.id DESC
         LIMIT ?`,
        [sessionId, userId, Math.max(2, Math.min(Number(limit) || MEMORY_CONTEXT_MESSAGE_LIMIT, 16))]
    ).catch(() => []);

    return rows
        .reverse()
        .map((message) => ({
            id: message.id,
            role: message.role,
            content: sanitizeMemoryContent(message.content).slice(0, 700)
        }))
        .filter((message) => message.content);
}

function buildMemoryExtractionContext(messages = []) {
    return (Array.isArray(messages) ? messages : [])
        .slice(-MEMORY_CONTEXT_MESSAGE_LIMIT)
        .map((message) => `${message.role === 'assistant' ? 'Assistant' : 'User'}: ${message.content}`)
        .join('\n')
        .slice(-2400);
}

function looksLikeMemoryQuestion(text) {
    return /(?:你|您|user|your).{0,30}(?:名字|姓名|年龄|几岁|职业|工作|职位|身份|身高|体重|喜欢|不喜欢|兴趣|爱好|擅长|优点|缺点|name|age|job|role|height|weight|like|interest|good at|weakness)/i.test(String(text || ''));
}

function looksLikeShortMemoryFollowupAnswer(userText, recentMessages = []) {
    const cleanUserText = sanitizeMemoryContent(userText);
    if (!cleanUserText || cleanUserText.length > 120 || looksLikeMemorySignal(cleanUserText)) return false;
    const normalizedUserText = normalizeMemoryKeyText(cleanUserText);
    if (!normalizedUserText || normalizedUserText.length > 80) return false;
    if (/^(是|不是|对|不对|嗯|好的|可以|ok|yes|no|好|行|不用|不要|不需要)$/i.test(normalizedUserText)) return false;

    const messages = Array.isArray(recentMessages) ? recentMessages : [];
    let latestUserIndex = -1;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i]?.role !== 'user') continue;
        const normalizedMessageText = normalizeMemoryKeyText(messages[i]?.content || '');
        if (
            normalizedMessageText === normalizedUserText ||
            normalizedMessageText.endsWith(normalizedUserText) ||
            normalizedUserText.endsWith(normalizedMessageText)
        ) {
            latestUserIndex = i;
            break;
        }
    }
    if (latestUserIndex <= 0) return false;

    const priorText = messages
        .slice(Math.max(0, latestUserIndex - 4), latestUserIndex)
        .map((message) => message.content)
        .join('\n');
    return looksLikeMemoryQuestion(priorText);
}

function getPriorMemoryQuestionText(userText, recentMessages = []) {
    if (!looksLikeShortMemoryFollowupAnswer(userText, recentMessages)) return '';
    const cleanUserText = sanitizeMemoryContent(userText);
    const normalizedUserText = normalizeMemoryKeyText(cleanUserText);
    const messages = Array.isArray(recentMessages) ? recentMessages : [];
    let latestUserIndex = -1;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i]?.role !== 'user') continue;
        const normalizedMessageText = normalizeMemoryKeyText(messages[i]?.content || '');
        if (
            normalizedMessageText === normalizedUserText ||
            normalizedMessageText.endsWith(normalizedUserText) ||
            normalizedUserText.endsWith(normalizedMessageText)
        ) {
            latestUserIndex = i;
            break;
        }
    }
    if (latestUserIndex <= 0) return '';
    return messages
        .slice(Math.max(0, latestUserIndex - 4), latestUserIndex)
        .map((message) => message.content)
        .join('\n');
}

function extractFollowupMemoryActions(text, recentMessages = []) {
    const clean = sanitizeMemoryContent(text);
    const questionText = getPriorMemoryQuestionText(clean, recentMessages);
    if (!clean || !questionText) return [];

    const actions = [];
    if (/(名字|姓名|怎么称呼|叫什么|name)/i.test(questionText)) {
        pushMemoryAction(actions, { category: 'identity', content: `用户名字是 ${clean}`, confidence: 0.82 });
    } else if (/(年龄|几岁|age)/i.test(questionText) && /^\d{1,3}\s*(?:岁|years? old)?$/i.test(clean)) {
        const age = clean.match(/\d{1,3}/)?.[0];
        if (age) pushMemoryAction(actions, { category: 'profile', content: `用户年龄是 ${age} 岁`, confidence: 0.82 });
    } else if (/(身高|height)/i.test(questionText) && /\d{2,3}/.test(clean)) {
        const height = clean.match(/\d{2,3}/)?.[0];
        if (height) pushMemoryAction(actions, { category: 'profile', content: `用户身高是 ${height} 厘米`, confidence: 0.78 });
    } else if (/(体重|weight)/i.test(questionText) && /\d{2,3}/.test(clean)) {
        const weight = clean.match(/\d{2,3}/)?.[0];
        if (weight) pushMemoryAction(actions, { category: 'profile', content: `用户体重是 ${weight}${/斤/.test(clean) ? ' 斤' : ' 公斤'}`, confidence: 0.78 });
    } else if (/(职业|工作|职位|身份|做什么|job|role|work)/i.test(questionText)) {
        pushMemoryAction(actions, { category: 'work', content: `用户身份/职业是 ${clean}`, confidence: 0.78 });
    } else if (/(喜欢|兴趣|爱好|感兴趣|like|interest|hobby)/i.test(questionText)) {
        pushMemoryAction(actions, { category: 'interest', content: `用户喜欢 ${clean}`, confidence: 0.76 });
    } else if (/(不喜欢|讨厌|dislike|hate)/i.test(questionText)) {
        pushMemoryAction(actions, { category: 'preference', content: `用户不喜欢 ${clean}`, confidence: 0.76 });
    } else if (/(擅长|能力|优点|good at|strength)/i.test(questionText)) {
        pushMemoryAction(actions, { category: 'ability', content: `用户擅长 ${clean}`, confidence: 0.76 });
    } else if (/(不擅长|缺点|弱点|weakness)/i.test(questionText)) {
        pushMemoryAction(actions, { category: 'weakness', content: `用户不擅长/弱点是 ${clean}`, confidence: 0.76 });
    }
    return actions;
}

async function buildConversationMemoryPrompt(userId) {
    const [memories, recentTitles] = await Promise.all([
        listActiveUserMemories(userId, LONG_MEMORY_PROMPT_LIMIT),
        getRecentConversationTitlesForMemory(userId, RECENT_TITLE_MEMORY_LIMIT)
    ]);

    const sections = [];
    sections.push([
        '[长期记忆]',
        memories.length > 0
            ? memories.map((memory) => `- #${memory.id} [${memory.category}] ${memory.content}`).join('\n')
            : '- 当前没有已保存的长期记忆。',
        'RAI 已具备跨对话长期记忆能力。用户问“你记得我什么/你对我的记忆有哪些”时，按本段如实列出长期记忆；如果为空，就说当前没有已保存长期记忆，并可提示用户在设置里添加或直接告诉你“记住……”。不要声称自己没有持久化记忆能力。',
        '如果用户明确要求删除、忘掉或移除某条长期记忆，优先调用 delete_memory 工具；可直接使用 # 后面的数字作为 memory_id。工具删除成功后只简短确认，不要继续引用已删除记忆。'
    ].join('\n'));

    if (recentTitles.length > 0) {
        sections.push([
            '[近期对话标题]',
            ...recentTitles.map((title) => `- ${title}`),
            '这些只是近期话题线索，不代表事实记忆；仅在有助于延续用户上下文时参考。'
        ].join('\n'));
    }

    return sections.join('\n\n');
}

function looksLikeMemorySignal(text) {
    const value = String(text || '');
    return /记住|记得|长期记|忘掉|忘记|删除记忆|删掉记忆|移除记忆|清除记忆|取消记忆|不要记|别记|不需要记|我叫|我的名字|我是|我是一名|我是一位|我的年龄|我\s*\d{1,3}\s*岁|我的身高|我身高|我的体重|我体重|我喜欢|我不喜欢|我讨厌|兴趣|爱好|擅长|不擅长|优点|缺点|职位|职业|身份|my name is|remember|forget|delete memory|remove memory|I am|I'm|I like|I dislike|I hate|my job|my role/i.test(value);
}

function pushMemoryAction(actions, action) {
    const normalizedAction = String(action?.action || 'upsert').toLowerCase() === 'delete' ? 'delete' : 'upsert';
    const content = sanitizeMemoryContent(action?.content || action?.target || '');
    if (!content) return;
    if (
        normalizedAction !== 'delete' &&
        /(?:api[_ -]?key|secret|token|password|密码|密钥|验证码|银行卡|信用卡|身份证)/i.test(content)
    ) {
        return;
    }
    if (
        normalizedAction !== 'delete' &&
        /用户身份\/职业是\s*(?:想|要|来|在|问|说|准备|打算|需要|希望|可以|不能|不是)/.test(content)
    ) {
        return;
    }
    actions.push({
        action: normalizedAction,
        category: normalizeMemoryCategory(action?.category),
        content,
        target: sanitizeMemoryContent(action?.target || content),
        confidence: Math.max(0.1, Math.min(Number(action?.confidence) || 0.85, 1))
    });
}

function extractHeuristicMemoryActions(text, recentMessages = []) {
    const source = String(text || '').normalize('NFKC');
    const actions = [];
    const explicitRemember = source.match(/(?:请|帮我)?(?:记住|记得|以后记得|长期记住)[:：\s]*(.{2,160})/);

    const deleteMatch = source.match(/(?:忘掉|删除|删掉|不要记住|别记住|不要记|别记|不需要记住)[:：\s]*(.{0,160})/);
    if (deleteMatch) {
        pushMemoryAction(actions, { action: 'delete', category: 'other', target: deleteMatch[1] || '全部记忆', content: deleteMatch[1] || '全部记忆', confidence: 0.9 });
        return actions;
    }

    const patterns = [
        { category: 'identity', regex: /(?:我叫|我的名字叫|我的名字是)\s*([^，。！？,.!\n]{1,40})/g, build: (v) => `用户名字是 ${v}` },
        { category: 'profile', regex: /(?:我的年龄是|我)\s*(\d{1,3})\s*岁/g, build: (v) => `用户年龄是 ${v} 岁` },
        { category: 'profile', regex: /(?:我的身高是|我身高)\s*(\d{2,3})\s*(?:cm|厘米|公分)?/gi, build: (v) => `用户身高是 ${v} 厘米` },
        { category: 'profile', regex: /(?:我的体重是|我体重)\s*(\d{2,3})\s*(?:kg|公斤|斤)?/gi, build: (v, match) => `用户体重是 ${v}${/斤/.test(match[0]) ? ' 斤' : ' 公斤'}` },
        { category: 'work', regex: /(?:我是|我是一名|我是一位)\s*([^，。！？,.!\n]{2,80})/g, build: (v) => `用户身份/职业是 ${v}` },
        { category: 'work', regex: /(?:我的职位是|我的职业是|我的工作是)\s*([^，。！？,.!\n]{2,80})/g, build: (v) => `用户职位/职业是 ${v}` },
        { category: 'interest', regex: /(?:我喜欢|我的兴趣是|我的爱好是|我对.+?感兴趣)\s*([^。！？!\n]{2,100})/g, build: (v) => `用户喜欢 ${v}` },
        { category: 'preference', regex: /(?:我不喜欢|我讨厌)\s*([^。！？!\n]{2,100})/g, build: (v) => `用户不喜欢 ${v}` },
        { category: 'ability', regex: /(?:我擅长|我的能力是|我会)\s*([^。！？!\n]{2,100})/g, build: (v) => `用户擅长 ${v}` },
        { category: 'weakness', regex: /(?:我不擅长|我的缺点是|我的弱点是)\s*([^。！？!\n]{2,100})/g, build: (v) => `用户不擅长/弱点是 ${v}` },
        { category: 'identity', regex: /my name is\s+([^,.!\n]{1,60})/gi, build: (v) => `User's name is ${v}` },
        { category: 'preference', regex: /I (?:like|love)\s+([^,.!\n]{2,100})/gi, build: (v) => `User likes ${v}` },
        { category: 'preference', regex: /I (?:dislike|hate)\s+([^,.!\n]{2,100})/gi, build: (v) => `User dislikes ${v}` }
    ];

    for (const pattern of patterns) {
        for (const match of source.matchAll(pattern.regex)) {
            const raw = sanitizeMemoryContent(match[1]);
            if (!raw) continue;
            pushMemoryAction(actions, {
                category: pattern.category,
                content: pattern.build(raw, match),
                confidence: 0.86
            });
        }
    }

    if (explicitRemember?.[1] && !actions.some((action) => action.action === 'upsert')) {
        pushMemoryAction(actions, { category: 'other', content: explicitRemember[1], confidence: 0.9 });
    }

    for (const action of extractFollowupMemoryActions(source, recentMessages)) {
        pushMemoryAction(actions, action);
    }

    return actions;
}

function extractJsonObjectText(text) {
    const value = String(text || '').trim();
    const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1].trim() : value;
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end <= start) return '';
    return candidate.slice(start, end + 1);
}

function parseMemoryActionsFromModelText(text) {
    try {
        const jsonText = extractJsonObjectText(text);
        if (!jsonText) return [];
        const parsed = JSON.parse(jsonText);
        const actions = Array.isArray(parsed?.actions) ? parsed.actions : [];
        const normalized = [];
        actions.forEach((action) => pushMemoryAction(normalized, action));
        return normalized;
    } catch (error) {
        console.warn(' 记忆提取 JSON 解析失败:', error.message);
        return [];
    }
}

async function callMemoryExtractionModel({ userText, assistantText = '', existingMemories = [], conversationContext = '' }) {
    const modelId = MEMORY_EXTRACTION_MODEL_ID;
    if (!isRuntimeConfiguredModel(modelId)) {
        appendRaiRuntimeReport({
            level: '报错',
            tag: 'memory_extraction_model_unavailable',
            message: 'DeepSeek V4 Flash is not configured for memory extraction',
            context: { modelId }
        });
        return [];
    }

    const routing = MODEL_ROUTING[modelId];
    const providerConfig = routing ? API_PROVIDERS[routing.provider] : null;
    if (!routing || !providerConfig?.apiKey || providerConfig.isGemini || routing.isGemini) return [];

    const system = [
        'You extract durable user memories for an assistant.',
        'Return strict JSON only: {"actions":[{"action":"upsert|delete","category":"identity|profile|preference|interest|ability|weakness|health|relationship|work|other","content":"...","target":"...","confidence":0.1-1}]}',
        'Save only stable personal facts about the user, such as name, age, identity, job, body stats, interests, preferences, abilities, weaknesses, or important background.',
        'Do not save one-off tasks, temporary requests, secrets, passwords, API keys, payment data, or guesses.',
        'If the user asks to forget/delete/correct a memory, output delete actions with target text.',
        'Keep each content self-contained and short.'
    ].join('\n');
    const existing = existingMemories
        .slice(0, 40)
        .map((memory) => `- #${memory.id} ${memory.category}: ${memory.content}`)
        .join('\n') || '(none)';
    const user = [
        `Existing memories:\n${existing}`,
        '',
        `Recent conversation context:\n${String(conversationContext || '').slice(0, 2400) || '(none)'}`,
        '',
        `Latest user message:\n${String(userText || '').slice(0, 1800)}`,
        '',
        `Assistant reply summary/content:\n${String(assistantText || '').slice(0, 1200)}`
    ].join('\n');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MEMORY_MODEL_TIMEOUT_MS);
    try {
        const response = await fetch(providerConfig.baseURL, {
            method: 'POST',
            headers: buildProviderFetchHeaders(providerConfig, routing.provider),
            body: JSON.stringify({
                model: routing.model,
                messages: [
                    { role: 'system', content: system },
                    { role: 'user', content: user }
                ],
                temperature: 0,
                max_tokens: MEMORY_MODEL_MAX_TOKENS,
                stream: false
            }),
            signal: controller.signal
        });
        const payloadText = await response.text();
        if (!response.ok) {
            appendRaiRuntimeReport({
                level: '报错',
                tag: 'memory_extraction_http_failed',
                message: `Memory extraction HTTP ${response.status}`,
                context: { modelId, provider: routing.provider, body: payloadText.slice(0, 600) }
            });
            return [];
        }
        let payload = null;
        try {
            payload = JSON.parse(payloadText);
        } catch {
            payload = null;
        }
        const content = payload?.choices?.[0]?.message?.content || payloadText;
        return parseMemoryActionsFromModelText(content);
    } catch (error) {
        appendRaiRuntimeReport({
            level: '报错',
            tag: 'memory_extraction_failed',
            message: error.message,
            context: { modelId, provider: routing.provider }
        });
        return [];
    } finally {
        clearTimeout(timeout);
    }
}

function dedupeMemoryActions(actions = []) {
    const seen = new Set();
    const result = [];
    for (const action of actions) {
        const key = `${action.action}:${normalizeMemoryCategory(action.category)}:${normalizeMemoryKeyText(action.target || action.content)}`;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        result.push(action);
    }
    return result;
}

async function upsertUserMemory({ userId, category, content, confidence = 0.8, sourceSessionId = null, sourceMessageId = null }) {
    const safeContent = sanitizeMemoryContent(content);
    if (safeContent.length < 2) return null;
    const safeCategory = normalizeMemoryCategory(category);
    const memoryKey = buildMemoryKey(safeCategory, safeContent);
    if (!memoryKey) return null;
    const result = await dbRunAsync(
        `INSERT INTO user_memories
         (user_id, memory_key, category, content, confidence, source_session_id, source_message_id, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL)
         ON CONFLICT(user_id, memory_key) DO UPDATE SET
           category = excluded.category,
           content = excluded.content,
           confidence = MAX(COALESCE(user_memories.confidence, 0), excluded.confidence),
           source_session_id = COALESCE(excluded.source_session_id, user_memories.source_session_id),
           source_message_id = COALESCE(excluded.source_message_id, user_memories.source_message_id),
           updated_at = CURRENT_TIMESTAMP,
           deleted_at = NULL`,
        [
            userId,
            memoryKey,
            safeCategory,
            safeContent,
            Math.max(0.1, Math.min(Number(confidence) || 0.8, 1)),
            sourceSessionId || null,
            sourceMessageId || null
        ]
    );
    return result;
}

async function softDeleteUserMemory(userId, memoryId) {
    return dbRunAsync(
        `UPDATE user_memories
         SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
        [memoryId, userId]
    );
}

function serializeDeletedMemory(memory) {
    if (!memory) return null;
    return {
        id: Number(memory.id),
        category: memory.category || 'other',
        content: memory.content || ''
    };
}

async function deleteUserMemoryByModel({ userId, memoryId = null, memoryIds = [], target = '', reason = '' } = {}) {
    const safeUserId = Number(userId);
    if (!Number.isInteger(safeUserId) || safeUserId <= 0) {
        return {
            success: false,
            deletedCount: 0,
            message: '缺少用户身份，无法删除记忆。'
        };
    }

    const safeTarget = sanitizeMemoryContent(target);
    const requestedIds = uniquePositiveMemoryIds([
        memoryIds,
        memoryId,
        extractMemoryIdsFromText(safeTarget)
    ]);

    if (requestedIds.length > 0) {
        const placeholders = requestedIds.map(() => '?').join(',');
        const memories = await dbAllAsync(
            `SELECT id, category, content
             FROM user_memories
             WHERE user_id = ? AND deleted_at IS NULL AND id IN (${placeholders})`,
            [safeUserId, ...requestedIds]
        ).catch(() => []);
        if (!Array.isArray(memories) || memories.length === 0) {
            return {
                success: false,
                deletedCount: 0,
                matchedBy: 'id',
                message: `没有找到 ${formatMemoryIdList(requestedIds)} 这些长期记忆。`
            };
        }

        let deletedCount = 0;
        for (const memory of memories) {
            const result = await softDeleteUserMemory(safeUserId, memory.id);
            deletedCount += Number(result?.changes || 0);
        }
        const deletedMemories = memories.map(serializeDeletedMemory);
        const deletedIds = deletedMemories.map((memory) => memory?.id);
        const missingIds = requestedIds.filter((id) => !deletedIds.includes(id));
        const deletedIdList = formatMemoryIdList(deletedIds);
        const missingSuffix = missingIds.length > 0 ? `（未找到 ${formatMemoryIdList(missingIds)}）` : '';
        return {
            success: deletedCount > 0,
            deletedCount,
            deletedMemory: deletedMemories.length === 1 ? deletedMemories[0] : null,
            deletedMemories,
            matchedBy: 'id',
            reason: sanitizeMemoryContent(reason).slice(0, 180),
            message: deletedCount > 0
                ? `已删除长期记忆 ${deletedIdList}。${missingSuffix}`
                : `没有找到 ${formatMemoryIdList(requestedIds)} 这些长期记忆。`
        };
    }

    const normalizedTarget = normalizeMemoryKeyText(safeTarget);
    if (!normalizedTarget || /^(全部记忆|所有记忆|allmemories|everything)$/.test(normalizedTarget)) {
        return {
            success: false,
            deletedCount: 0,
            matchedBy: 'target',
            message: 'delete_memory 需要一条具体记忆的编号或准确文本，不能用于不确认地清空全部记忆。'
        };
    }

    const memories = await listActiveUserMemories(safeUserId, 200);
    const matches = memories.filter((memory) => {
        const normalizedContent = normalizeMemoryKeyText(memory.content);
        if (!normalizedContent) return false;
        return normalizedContent.includes(normalizedTarget) || normalizedTarget.includes(normalizedContent);
    });

    for (const memory of matches) {
        await softDeleteUserMemory(safeUserId, memory.id);
    }

    return {
        success: matches.length > 0,
        deletedCount: matches.length,
        deletedMemory: matches.length === 1 ? serializeDeletedMemory(matches[0]) : null,
        deletedMemories: matches.map(serializeDeletedMemory),
        matchedBy: 'target',
        reason: sanitizeMemoryContent(reason).slice(0, 180),
        message: matches.length > 0
            ? `已删除 ${matches.length} 条匹配的长期记忆。`
            : '没有找到匹配的长期记忆。'
    };
}

async function deleteMemoriesByTarget(userId, target) {
    const safeTarget = sanitizeMemoryContent(target);
    const memoryIds = extractMemoryIdsFromText(safeTarget);
    if (memoryIds.length > 0) {
        let changes = 0;
        for (const memoryId of memoryIds) {
            const result = await softDeleteUserMemory(userId, memoryId);
            changes += Number(result?.changes || 0);
        }
        return { changes };
    }

    const normalizedTarget = normalizeMemoryKeyText(safeTarget);
    if (!normalizedTarget || /^(全部记忆|所有记忆|allmemories|everything)$/.test(normalizedTarget)) {
        return dbRunAsync(
            `UPDATE user_memories
             SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE user_id = ? AND deleted_at IS NULL`,
            [userId]
        );
    }

    const memories = await listActiveUserMemories(userId, 200);
    const matches = memories.filter((memory) => {
        const normalizedContent = normalizeMemoryKeyText(memory.content);
        return normalizedContent.includes(normalizedTarget) || normalizedTarget.includes(normalizedContent);
    });

    for (const memory of matches) {
        await softDeleteUserMemory(userId, memory.id);
    }
    return { changes: matches.length };
}

async function applyMemoryActions({ userId, sessionId, sourceMessageId = null, actions = [] }) {
    const normalizedActions = dedupeMemoryActions(actions);
    if (normalizedActions.length === 0) return 0;
    for (const action of normalizedActions) {
        if (action.action === 'delete') {
            await deleteMemoriesByTarget(userId, action.target || action.content);
        } else {
            await upsertUserMemory({
                userId,
                category: action.category,
                content: action.content,
                confidence: action.confidence,
                sourceSessionId: sessionId,
                sourceMessageId
            });
        }
    }
    return normalizedActions.length;
}

async function processConversationMemory({ userId, sessionId, userContent, assistantContent = '', sourceMessageId = null }) {
    const cleanUserContent = sanitizeMemoryContent(stripInlinePromptTimeHint(userContent));
    if (!cleanUserContent) return;
    const enabled = await isUserLongMemoryEnabled(userId);
    if (!enabled) return;

    const recentMessages = await getRecentSessionMessagesForMemory(userId, sessionId, MEMORY_CONTEXT_MESSAGE_LIMIT);
    const shouldProcess = looksLikeMemorySignal(cleanUserContent) || looksLikeShortMemoryFollowupAnswer(cleanUserContent, recentMessages);
    if (!shouldProcess) return;

    const existingMemories = await listActiveUserMemories(userId, 80);
    const heuristicActions = extractHeuristicMemoryActions(cleanUserContent, recentMessages);
    const heuristicCount = await applyMemoryActions({
        userId,
        sessionId,
        sourceMessageId,
        actions: heuristicActions
    });
    if (heuristicCount > 0) {
        console.log(` 长期记忆规则处理完成: userId=${userId}, actions=${heuristicCount}`);
        return;
    }

    const modelActions = await callMemoryExtractionModel({
        userText: cleanUserContent,
        assistantText: sanitizeMemoryContent(assistantContent),
        existingMemories,
        conversationContext: buildMemoryExtractionContext(recentMessages)
    });
    const modelCount = await applyMemoryActions({
        userId,
        sessionId,
        sourceMessageId,
        actions: modelActions
    });
    if (modelCount > 0) {
        console.log(` 长期记忆模型处理完成: userId=${userId}, actions=${modelCount}`);
    }
}

function scheduleConversationMemoryProcessing(payload) {
    setTimeout(() => {
        processConversationMemory(payload).catch((error) => {
            console.warn(' 长期记忆处理失败:', error.message);
            appendRaiRuntimeReport({
                level: '报错',
                tag: 'memory_processing_failed',
                message: error.message,
                context: {
                    userId: payload?.userId,
                    sessionId: payload?.sessionId
                }
            });
        });
    }, 0);
}

function buildMembershipEndISO(currentEnd, durationDays) {
    const now = new Date();
    const parsedEnd = currentEnd ? new Date(currentEnd) : null;
    const hasActiveEnd = parsedEnd && !Number.isNaN(parsedEnd.getTime()) && parsedEnd > now;
    const baseDate = hasActiveEnd ? parsedEnd : now;
    const nextEnd = new Date(baseDate.getTime());
    nextEnd.setDate(nextEnd.getDate() + durationDays);
    return nextEnd.toISOString();
}

async function getUserMembershipSnapshot(userId) {
    const user = await dbGetAsync(`
        SELECT id, email, username, created_at,
               COALESCE(membership, 'free') AS membership,
               membership_start, membership_end,
               COALESCE(points, 0) AS points,
               COALESCE(purchased_points, 0) AS purchased_points,
               purchased_points_expire,
               last_checkin, last_daily_grant,
               gpt55_usage_date, COALESCE(gpt55_usage_count, 0) AS gpt55_usage_count
        FROM users WHERE id = ?
    `, [userId]);

    if (!user) return null;

    const now = new Date();
    const today = getTodayDateString();
    let membership = user.membership || 'free';
    let membershipStart = user.membership_start || null;
    let membershipEnd = user.membership_end || null;

    if (membership !== 'free' && membershipEnd) {
        const endDate = new Date(membershipEnd);
        if (!Number.isNaN(endDate.getTime()) && endDate < now) {
            membership = 'free';
            membershipStart = null;
            membershipEnd = null;
            await dbRunAsync(
                'UPDATE users SET membership = ?, membership_start = NULL, membership_end = NULL WHERE id = ?',
                ['free', user.id]
            );
        }
    }

    let points = Number(user.points || 0);
    let purchasedPoints = Number(user.purchased_points || 0);
    let purchasedPointsExpire = user.purchased_points_expire || null;

    if (purchasedPoints > 0 && purchasedPointsExpire) {
        const expireDate = new Date(purchasedPointsExpire);
        if (!Number.isNaN(expireDate.getTime()) && expireDate < now) {
            purchasedPoints = 0;
            purchasedPointsExpire = null;
            await dbRunAsync(
                'UPDATE users SET purchased_points = 0, purchased_points_expire = NULL WHERE id = ?',
                [user.id]
            );
        }
    }

    const totalPoints = points + purchasedPoints;
    const canCheckin = user.last_checkin !== today;
    const tasks = await getUserTaskSnapshot(user.id);

    return {
        membership,
        membershipStart,
        membershipEnd,
        points,
        purchasedPoints,
        purchasedPointsExpire,
        totalPoints,
        canCheckin,
        lastCheckin: user.last_checkin,
        createdAt: user.created_at,
        tasks
    };
}

// 获取会员状态和点数
app.get('/api/user/membership', authenticateToken, async (req, res) => {
    try {
        const snapshot = await getUserMembershipSnapshot(req.user.userId);
        if (!snapshot) {
            return res.status(404).json({ error: '用户不存在' });
        }
        res.json(snapshot);
    } catch (error) {
        console.error(' 获取会员状态失败:', error);
        res.status(500).json({ error: '获取会员状态失败' });
    }
});

// 每日签到（所有登录用户每天一次）
app.post('/api/user/checkin', authenticateToken, async (req, res) => {
    try {
        const user = await dbGetAsync(
            'SELECT id, COALESCE(points, 0) AS points, last_checkin FROM users WHERE id = ?',
            [req.user.userId]
        );

        if (!user) {
            return res.status(404).json({ error: '用户不存在' });
        }

        const today = getTodayDateString();
        if (user.last_checkin === today) {
            return res.status(400).json({ error: '今日已签到' });
        }

        const pointsGained = MEMBERSHIP_CONFIG.free.checkinPoints;
        const newPoints = Number(user.points || 0) + pointsGained;

        await dbRunAsync(
            'UPDATE users SET points = ?, last_checkin = ? WHERE id = ?',
            [newPoints, today, user.id]
        );

        const snapshot = await getUserMembershipSnapshot(user.id);
        console.log(` 用户 ${user.id} 签到成功，获得 ${pointsGained} 点数`);
        res.json({
            success: true,
            pointsGained,
            newPoints,
            currentPoints: snapshot?.totalPoints ?? newPoints,
            totalPoints: snapshot?.totalPoints ?? newPoints,
            canCheckin: snapshot?.canCheckin ?? false
        });
    } catch (error) {
        console.error(' 签到失败:', error);
        res.status(500).json({ error: '签到失败' });
    }
});

app.post('/api/user/tasks/pwa-install/complete', authenticateToken, async (req, res) => {
    try {
        const settings = await getAdminRuntimeSettings();
        if (Number(settings.pwa_reward_enabled || 0) !== 1) {
            return res.status(403).json({ error: 'PWA 奖励当前已关闭' });
        }

        const user = await dbGetAsync('SELECT id, created_at FROM users WHERE id = ?', [req.user.userId]);
        if (!user) {
            return res.status(404).json({ error: '用户不存在' });
        }
        const minAgeMinutes = Number(settings.pwa_reward_min_account_age_minutes || 0);
        const createdAt = new Date(user.created_at || Date.now()).getTime();
        const accountAgeMs = Date.now() - createdAt;
        if (minAgeMinutes > 0 && accountAgeMs < minAgeMinutes * 60 * 1000) {
            return res.status(429).json({
                error: `账号创建满 ${minAgeMinutes} 分钟后才能领取该奖励`,
                code: 'pwa_reward_cooling_down',
                minAgeMinutes,
                remainingSeconds: Math.ceil((minAgeMinutes * 60 * 1000 - accountAgeMs) / 1000)
            });
        }

        const source = String(req.body?.source || 'unknown').slice(0, 80);
        const reward = await awardUserTaskPoints({
            userId: user.id,
            taskKey: USER_TASK_REWARDS.pwaInstall.key,
            points: USER_TASK_REWARDS.pwaInstall.points,
            metadata: buildTaskMetadata(req, { source })
        });
        const snapshot = await getUserMembershipSnapshot(user.id);

        if (reward.awarded) {
            console.log(` 用户 ${user.id} 完成桌面App任务，获得 ${reward.pointsGained} 点数`);
        }

        res.json({
            success: true,
            ...reward,
            ...snapshot
        });
    } catch (error) {
        console.error(' 完成桌面App任务失败:', error);
        res.status(500).json({ error: '完成任务失败' });
    }
});

// 收藏新域名任务（自助领取，幂等）
app.post('/api/user/tasks/bookmark-domain/complete', authenticateToken, async (req, res) => {
    try {
        const user = await dbGetAsync('SELECT id FROM users WHERE id = ?', [req.user.userId]);
        if (!user) {
            return res.status(404).json({ error: '用户不存在' });
        }

        const reward = await awardUserTaskPoints({
            userId: user.id,
            taskKey: USER_TASK_REWARDS.bookmarkDomain.key,
            points: USER_TASK_REWARDS.bookmarkDomain.points,
            metadata: buildTaskMetadata(req, { source: 'bookmark-domain-claim' })
        });
        const snapshot = await getUserMembershipSnapshot(user.id);

        if (reward.awarded) {
            console.log(` 用户 ${user.id} 完成收藏新域名任务，获得 ${reward.pointsGained} 点数`);
        }

        res.json({
            success: true,
            ...reward,
            ...snapshot
        });
    } catch (error) {
        console.error(' 完成收藏新域名任务失败:', error);
        res.status(500).json({ error: '完成任务失败' });
    }
});

// 公开公告接口：按启用状态与当前时间窗口过滤
app.get('/api/announcements', async (req, res) => {
    try {
        const now = new Date().toISOString();
        const language = normalizeAnnouncementLanguage(req.query?.lang || req.headers['accept-language'] || '');
        const rows = await dbAllAsync(
            `SELECT id, title, body, title_en, body_en, delivery_mode, start_at, end_at, enabled, created_at, updated_at
             FROM announcements
             WHERE enabled = 1
               AND (start_at IS NULL OR start_at <= ?)
               AND (end_at   IS NULL OR end_at   >= ?)
             ORDER BY COALESCE(updated_at, created_at) DESC, id DESC`,
            [now, now]
        );
        res.json({ announcements: rows.map((row) => serializeAnnouncement(row, { language })) });
    } catch (error) {
        console.error(' 获取公告失败:', error);
        res.status(500).json({ error: '获取公告失败' });
    }
});
app.post('/api/user/membership/redeem', authenticateToken, async (req, res) => {
    const tier = String(req.body?.tier || '').trim();
    const config = MEMBERSHIP_CONFIG[tier];

    if (!config || tier === 'free') {
        return res.status(400).json({ error: '无效的会员档位' });
    }

    let inTransaction = false;

    try {
        await dbRunAsync('BEGIN IMMEDIATE TRANSACTION');
        inTransaction = true;

        const user = await dbGetAsync(`
            SELECT id,
                   membership, membership_start, membership_end,
                   COALESCE(points, 0) AS points,
                   COALESCE(purchased_points, 0) AS purchased_points,
                   purchased_points_expire
            FROM users WHERE id = ?
        `, [req.user.userId]);

        if (!user) {
            await dbRunAsync('ROLLBACK');
            inTransaction = false;
            return res.status(404).json({ error: '用户不存在' });
        }

        const currentMembership = String(user.membership || 'free');
        const currentMembershipEnd = user.membership_end ? new Date(user.membership_end) : null;
        const hasActiveMembership = currentMembership !== 'free' &&
            currentMembershipEnd &&
            !Number.isNaN(currentMembershipEnd.getTime()) &&
            currentMembershipEnd > new Date();

        if (currentMembership === 'MAX' && tier === 'Pro' && hasActiveMembership) {
            await dbRunAsync('ROLLBACK');
            inTransaction = false;
            return res.status(400).json({ error: '当前已是更高档位，请直接续期当前会员' });
        }

        let points = Number(user.points || 0);
        let purchasedPoints = Number(user.purchased_points || 0);
        let purchasedPointsExpire = user.purchased_points_expire || null;

        if (purchasedPoints > 0 && purchasedPointsExpire) {
            const expireDate = new Date(purchasedPointsExpire);
            if (!Number.isNaN(expireDate.getTime()) && expireDate < new Date()) {
                purchasedPoints = 0;
                purchasedPointsExpire = null;
                await dbRunAsync(
                    'UPDATE users SET purchased_points = 0, purchased_points_expire = NULL WHERE id = ?',
                    [user.id]
                );
            }
        }

        const totalPoints = points + purchasedPoints;
        if (totalPoints < config.redeemCost) {
            await dbRunAsync('ROLLBACK');
            inTransaction = false;
            return res.status(400).json({ error: '点数不足，请完成任务或签到增加积分' });
        }

        let remainingCost = config.redeemCost;
        if (points >= remainingCost) {
            points -= remainingCost;
            remainingCost = 0;
        } else {
            remainingCost -= points;
            points = 0;
            purchasedPoints -= remainingCost;
        }

        const membershipStart = new Date().toISOString();
        const membershipEnd = buildMembershipEndISO(user.membership_end, config.durationDays);

        await dbRunAsync(`
            UPDATE users SET
                membership = ?,
                membership_start = ?,
                membership_end = ?,
                points = ?,
                purchased_points = ?,
                purchased_points_expire = ?,
                last_daily_grant = NULL
            WHERE id = ?
        `, [
            tier,
            membershipStart,
            membershipEnd,
            points,
            purchasedPoints,
            purchasedPoints > 0 ? purchasedPointsExpire : null,
            user.id
        ]);

        await dbRunAsync('COMMIT');
        inTransaction = false;

        const snapshot = await getUserMembershipSnapshot(user.id);
        console.log(` 用户 ${user.id} 兑换会员成功: ${tier}, 扣除 ${config.redeemCost} 点`);
        res.json({
            success: true,
            tier,
            pointsSpent: config.redeemCost,
            ...snapshot
        });
    } catch (error) {
        if (inTransaction) {
            try {
                await dbRunAsync('ROLLBACK');
            } catch (rollbackError) {
                console.error(' 兑换会员回滚失败:', rollbackError);
            }
        }
        console.error(' 兑换会员失败:', error);
        res.status(500).json({ error: '兑换会员失败' });
    }
});
const FREE_MODEL_IDENTIFIERS = new Set([
    'chatgpt-gpt-oss-120b',
    'gemma',
    'gemma-4-31b-it',
    'north-mini-code',
    'nemotron-3-ultra',
    'openrouter-free',
    'openai/gpt-oss-120b:free',
    'google/gemma-4-31b-it:free',
    'cohere/north-mini-code:free',
    'nvidia/nemotron-3-ultra-550b-a55b:free',
    'openrouter/free'
]);

function isFreeModelIdentifier(modelUsed = '') {
    const modelText = String(modelUsed || '').trim().toLowerCase();
    if (!modelText) return false;

    return FREE_MODEL_IDENTIFIERS.has(modelText);
}

// 辅助函数：检查并扣减点数
async function checkAndDeductPoints(userId, modelUsed) {
    await dbRunAsync('BEGIN IMMEDIATE TRANSACTION');
    try {
        const user = await dbGetAsync(`
            SELECT id, membership, points, purchased_points, purchased_points_expire
            FROM users WHERE id = ?
        `, [userId]);
        if (!user) throw new Error('用户不存在');

        let points = Number(user.points || 0);
        let purchasedPoints = Number(user.purchased_points || 0);

        if (purchasedPoints > 0 && user.purchased_points_expire) {
            const expireDate = new Date(user.purchased_points_expire);
            if (Number.isFinite(expireDate.getTime()) && expireDate < new Date()) {
                purchasedPoints = 0;
                await dbRunAsync('UPDATE users SET purchased_points = 0 WHERE id = ?', [userId]);
            }
        }

        const totalPoints = points + purchasedPoints;

        if (isFreeModelIdentifier(modelUsed)) {
            await dbRunAsync('COMMIT');
            return {
                allowed: true,
                pointsDeducted: 0,
                remainingPoints: totalPoints,
                useFreeModel: false
            };
        }

        if (totalPoints <= 0) {
            await dbRunAsync('COMMIT');
            return {
                allowed: true,
                pointsDeducted: 0,
                remainingPoints: 0,
                useFreeModel: true,
                message: '点数不足，已自动切换到免费模型。完成任务或签到可增加积分。'
            };
        }

        let newPoints = points;
        let newPurchasedPoints = purchasedPoints;

        if (points > 0) {
            newPoints = points - 1;
        } else {
            newPurchasedPoints = purchasedPoints - 1;
        }

        const result = await dbRunAsync(
            'UPDATE users SET points = ?, purchased_points = ? WHERE id = ?',
            [newPoints, newPurchasedPoints, userId]
        );
        if (Number(result?.changes || 0) !== 1) {
            throw new Error('points_update_failed');
        }

        await dbRunAsync('COMMIT');
        return {
            allowed: true,
            pointsDeducted: 1,
            remainingPoints: newPoints + newPurchasedPoints,
            useFreeModel: false
        };
    } catch (error) {
        await dbRunAsync('ROLLBACK').catch(() => null);
        throw error;
    }
}

// ==================== 管理员后台系统 ====================

// 管理员认证中间件
const authenticateAdmin = (req, res, next) => {
    const token = req.headers['x-admin-token'];
    if (!token) {
        return res.status(401).json({ error: '需要管理员令牌' });
    }
    try {
        const decoded = jwt.verify(token, ADMIN_JWT_SECRET);
        if (decoded.isAdmin) {
            req.isAdmin = true;
            next();
        } else {
            res.status(403).json({ error: '无效的管理员令牌' });
        }
    } catch (e) {
        res.status(403).json({ error: '管理员令牌已过期或无效' });
    }
};

// 管理员登录
app.post('/api/admin/login', adminLoginLimiter, async (req, res) => {
    const { username, password, totpCode } = req.body;

    try {
        const usernameOk = String(username || '').trim() === ADMIN_USERNAME;
        const passwordInput = typeof password === 'string' ? password : '';
        const passwordOk = usernameOk
            && !validatePasswordLength(passwordInput)
            && await bcrypt.compare(passwordInput, ADMIN_PASSWORD_HASH);

        if (passwordOk) {
            if (ADMIN_TOTP_REQUIRED && !ADMIN_TOTP_SECRET) {
                console.error(' 管理员二步验证被要求但 ADMIN_TOTP_SECRET 未配置');
                return res.status(503).json({
                    error: '管理员二步验证未配置',
                    requiresTwoFactor: true
                });
            }

            if ((ADMIN_TOTP_REQUIRED || ADMIN_TOTP_SECRET) && !verifyTotpCode(ADMIN_TOTP_SECRET, totpCode)) {
                console.log(' 管理员二步验证失败尝试');
                return res.status(401).json({
                    error: 'Authenticator 验证码无效',
                    requiresTwoFactor: true
                });
            }

            const token = jwt.sign({ isAdmin: true, username: ADMIN_USERNAME, loginTime: Date.now() }, ADMIN_JWT_SECRET, { expiresIn: ADMIN_TOKEN_EXPIRES_IN });
            console.log(' 管理员登录成功');
            return res.json({ success: true, token, expiresIn: ADMIN_TOKEN_EXPIRES_IN });
        }

        console.log(' 管理员登录失败尝试');
        return res.status(401).json({ error: '管理员凭据无效' });
    } catch (err) {
        console.error(' 管理员登录校验失败:', err.message);
        return res.status(401).json({ error: '管理员凭据无效' });
    }
});

// 验证管理员Token
app.get('/api/admin/verify', authenticateAdmin, (req, res) => {
    const token = jwt.sign({ isAdmin: true, username: ADMIN_USERNAME, loginTime: Date.now() }, ADMIN_JWT_SECRET, { expiresIn: ADMIN_TOKEN_EXPIRES_IN });
    res.json({ success: true, isAdmin: true, token, expiresIn: ADMIN_TOKEN_EXPIRES_IN });
});

app.get('/api/admin/runtime-settings', authenticateAdmin, async (req, res) => {
    try {
        const settings = await getAdminRuntimeSettings();
        res.json({ settings });
    } catch (error) {
        console.error(' 获取管理员运行限制失败:', error);
        res.status(500).json({ error: '获取运行限制失败' });
    }
});

app.put('/api/admin/runtime-settings', authenticateAdmin, async (req, res) => {
    try {
        const settings = await setAdminRuntimeSettings(req.body || {});
        res.json({ success: true, settings });
    } catch (error) {
        console.error(' 保存管理员运行限制失败:', error);
        res.status(500).json({ error: '保存运行限制失败' });
    }
});

app.get('/api/admin/models', authenticateAdmin, async (req, res) => {
    try {
        const models = await getModelVisibilityPayload({ forceRefresh: true });
        res.json({ models });
    } catch (error) {
        console.error(' 管理员获取模型开关失败:', error);
        res.status(500).json({ error: '获取模型开关失败' });
    }
});

app.put('/api/admin/models/:modelId', authenticateAdmin, async (req, res) => {
    try {
        const modelId = normalizeAdminModelId(req.params.modelId);
        if (!modelId) {
            return res.status(400).json({ error: '无效的模型ID' });
        }

        const enabled = req.body?.enabled === true || req.body?.enabled === 1 || req.body?.enabled === '1';
        await dbRunAsync(`
            INSERT INTO model_visibility (model_id, enabled, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(model_id) DO UPDATE SET
                enabled = excluded.enabled,
                updated_at = CURRENT_TIMESTAMP
        `, [modelId, enabled ? 1 : 0]);
        modelAvailabilityCache.loadedAt = 0;

        const models = await getModelVisibilityPayload({ forceRefresh: true });
        res.json({ success: true, modelId, enabled, models });
    } catch (error) {
        console.error(' 管理员更新模型开关失败:', error);
        res.status(500).json({ error: '更新模型开关失败' });
    }
});

// ==================== 管理端公告 CRUD（均经 authenticateAdmin）====================
app.get('/api/admin/announcements', authenticateAdmin, async (req, res) => {
    try {
        const rows = await dbAllAsync(
            `SELECT id, title, body, title_en, body_en, delivery_mode, start_at, end_at, enabled, created_at, updated_at
             FROM announcements
             ORDER BY COALESCE(updated_at, created_at) DESC, id DESC`
        );
        res.json({ announcements: rows.map(serializeAnnouncement) });
    } catch (error) {
        console.error(' 管理员获取公告失败:', error);
        res.status(500).json({ error: '获取公告失败' });
    }
});

app.post('/api/admin/announcements', authenticateAdmin, async (req, res) => {
    try {
        const parsed = normalizeAnnouncementInput(req.body || {});
        if (parsed.error) {
            return res.status(400).json({ error: parsed.error });
        }
        const { title, body, titleEn, bodyEn, deliveryMode, startAt, endAt, enabled } = parsed.value;
        const result = await dbRunAsync(
            `INSERT INTO announcements (title, body, title_en, body_en, delivery_mode, start_at, end_at, enabled, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
            [title, body, titleEn, bodyEn, deliveryMode, startAt, endAt, enabled]
        );
        const row = await dbGetAsync('SELECT * FROM announcements WHERE id = ?', [result.lastID]);
        res.json({ success: true, announcement: serializeAnnouncement(row) });
    } catch (error) {
        console.error(' 管理员创建公告失败:', error);
        res.status(500).json({ error: '创建公告失败' });
    }
});

app.put('/api/admin/announcements/:id', authenticateAdmin, async (req, res) => {
    try {
        const id = Number.parseInt(req.params.id, 10);
        if (!Number.isSafeInteger(id) || id <= 0) {
            return res.status(400).json({ error: '无效的公告ID' });
        }
        const existing = await dbGetAsync('SELECT id FROM announcements WHERE id = ?', [id]);
        if (!existing) {
            return res.status(404).json({ error: '公告不存在' });
        }
        const parsed = normalizeAnnouncementInput(req.body || {});
        if (parsed.error) {
            return res.status(400).json({ error: parsed.error });
        }
        const { title, body, titleEn, bodyEn, deliveryMode, startAt, endAt, enabled } = parsed.value;
        await dbRunAsync(
            `UPDATE announcements
             SET title = ?, body = ?, title_en = ?, body_en = ?, delivery_mode = ?, start_at = ?, end_at = ?, enabled = ?, updated_at = datetime('now')
             WHERE id = ?`,
            [title, body, titleEn, bodyEn, deliveryMode, startAt, endAt, enabled, id]
        );
        const row = await dbGetAsync('SELECT * FROM announcements WHERE id = ?', [id]);
        res.json({ success: true, announcement: serializeAnnouncement(row) });
    } catch (error) {
        console.error(' 管理员更新公告失败:', error);
        res.status(500).json({ error: '更新公告失败' });
    }
});

app.delete('/api/admin/announcements/:id', authenticateAdmin, async (req, res) => {
    try {
        const id = Number.parseInt(req.params.id, 10);
        if (!Number.isSafeInteger(id) || id <= 0) {
            return res.status(400).json({ error: '无效的公告ID' });
        }
        const existing = await dbGetAsync('SELECT id FROM announcements WHERE id = ?', [id]);
        if (!existing) {
            return res.status(404).json({ error: '公告不存在' });
        }
        await dbRunAsync('DELETE FROM announcements WHERE id = ?', [id]);
        res.json({ success: true, id });
    } catch (error) {
        console.error(' 管理员删除公告失败:', error);
        res.status(500).json({ error: '删除公告失败' });
    }
});

const ADMIN_BROADCAST_SUBJECT_MAX_LENGTH = 180;
const ADMIN_BROADCAST_BODY_MAX_LENGTH = 100000;

function normalizeAdminBroadcastInput(raw) {
    const subject = String(raw?.subject || '').trim().replace(/\s+/g, ' ');
    const html = String(raw?.html || '').trim();
    const text = raw?.text === undefined || raw?.text === null ? '' : String(raw.text).trim();
    const testEmail = normalizeEmailForAuth(raw?.testEmail || '');

    if (!subject || !html) {
        return { error: 'subject 和 html 不能为空' };
    }
    if (subject.length > ADMIN_BROADCAST_SUBJECT_MAX_LENGTH) {
        return { error: `subject 不能超过${ADMIN_BROADCAST_SUBJECT_MAX_LENGTH}个字符` };
    }
    if (html.length > ADMIN_BROADCAST_BODY_MAX_LENGTH || text.length > ADMIN_BROADCAST_BODY_MAX_LENGTH) {
        return { error: `邮件正文不能超过${ADMIN_BROADCAST_BODY_MAX_LENGTH}个字符` };
    }
    if (testEmail && !isValidEmailForAuth(testEmail)) {
        return { error: '测试收件人邮箱格式不正确' };
    }

    return { value: { subject, html, text, testEmail } };
}

// 群发邮件给所有已验证邮箱用户（管理员）
app.post('/api/admin/broadcast', authenticateAdmin, async (req, res) => {
    try {
        const parsed = normalizeAdminBroadcastInput(req.body || {});
        if (parsed.error) {
            return res.status(400).json({ success: false, error: parsed.error });
        }
        const { subject, html, text, testEmail } = parsed.value;
        if (testEmail) {
            await sendResendEmail({ to: testEmail, subject, html, text });
            return res.json({ success: true, mode: 'test', sent: 1, failed: 0 });
        }
        if (String(req.body?.confirm || '') !== 'SEND') {
            return res.status(400).json({ success: false, error: '群发需要显式确认' });
        }
        const rows = await dbAllAsync(
            `SELECT email, username FROM users WHERE email_verified = 1 AND email NOT LIKE '%@passport.ztx6d.local' AND email NOT LIKE '%@ztx6d.local'`
        );
        let sent = 0;
        let failed = 0;
        const failures = [];
        for (const row of rows) {
            try {
                await sendResendEmail({ to: row.email, subject, html, text });
                sent += 1;
                await new Promise((r) => setTimeout(r, 200));
            } catch (error) {
                failed += 1;
                if (failures.length < 20) failures.push({ email: row.email, error: error.message });
                console.warn(` broadcast 发送失败 ${row.email}:`, error.message);
            }
        }
        appendRaiRuntimeReport({
            level: '信息',
            tag: 'admin_broadcast',
            message: `管理员群发邮件: sent=${sent}, failed=${failed}`,
            context: { subject, total: rows.length, sent, failed }
        });
        res.json({ success: true, mode: 'broadcast', sent, failed, total: rows.length, failures });
    } catch (error) {
        console.error(' 管理员群发邮件失败:', error);
        res.status(500).json({ success: false, error: '群发失败: ' + error.message });
    }
});

// 获取数据统计
app.get('/api/admin/stats', authenticateAdmin, async (req, res) => {
    try {
        // 基础统计
        const totalUsers = await new Promise((resolve, reject) => {
            db.get('SELECT COUNT(*) as count FROM users', (err, row) => {
                if (err) reject(err);
                else resolve(row.count);
            });
        });

        const totalSessions = await new Promise((resolve, reject) => {
            db.get('SELECT COUNT(*) as count FROM sessions', (err, row) => {
                if (err) reject(err);
                else resolve(row.count);
            });
        });

        const totalMessages = await new Promise((resolve, reject) => {
            db.get('SELECT COUNT(*) as count FROM messages', (err, row) => {
                if (err) reject(err);
                else resolve(row.count);
            });
        });

        // 今日统计
        const todayMessages = await new Promise((resolve, reject) => {
            db.get("SELECT COUNT(*) as count FROM messages WHERE DATE(created_at) = DATE('now')", (err, row) => {
                if (err) reject(err);
                else resolve(row.count);
            });
        });

        // 最近30天每日消息数
        const dailyStats = await new Promise((resolve, reject) => {
            db.all(`
                SELECT DATE(created_at) as date, COUNT(*) as messages
                FROM messages
                WHERE created_at >= DATE('now', '-30 days')
                GROUP BY DATE(created_at)
                ORDER BY date ASC
            `, (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });

        // 模型使用统计
        const modelUsage = await new Promise((resolve, reject) => {
            db.all(`
                SELECT model, COUNT(*) as count
                FROM messages
                WHERE model IS NOT NULL AND model != ''
                GROUP BY model
                ORDER BY count DESC
            `, (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });

        // 活跃用户排行（前10）
        const topUsers = await new Promise((resolve, reject) => {
            db.all(`
                SELECT u.id, u.username, u.email, COUNT(m.id) as messageCount
                FROM users u
                LEFT JOIN sessions s ON u.id = s.user_id
                LEFT JOIN messages m ON s.id = m.session_id
                GROUP BY u.id
                ORDER BY messageCount DESC
                LIMIT 10
            `, (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });

        const feedbackStats = await dbGetAsync(`
            SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN rating = 'up' THEN 1 ELSE 0 END) AS positive,
                SUM(CASE WHEN rating = 'down' THEN 1 ELSE 0 END) AS negative
            FROM message_feedback
        `);

        res.json({
            totalUsers,
            totalSessions,
            totalMessages,
            todayMessages,
            dailyStats,
            modelUsage,
            topUsers,
            feedbackStats: {
                total: Number(feedbackStats?.total || 0),
                positive: Number(feedbackStats?.positive || 0),
                negative: Number(feedbackStats?.negative || 0)
            }
        });

    } catch (error) {
        console.error(' 获取统计数据失败:', error);
        res.status(500).json({ error: '获取统计数据失败' });
    }
});

app.get('/api/admin/feedback', authenticateAdmin, async (req, res) => {
    try {
        const offset = parseBoundedInteger(req.query.offset, 0, 0, 100000);
        const limit = parseBoundedInteger(req.query.limit, 50, 1, 100);
        const rating = String(req.query.rating || '').trim();
        const search = String(req.query.search || '').trim();

        const where = [];
        const params = [];

        if (['up', 'down'].includes(rating)) {
            where.push('mf.rating = ?');
            params.push(rating);
        }

        if (search) {
            where.push(`(
                mf.comment LIKE ? OR
                m.content LIKE ? OR
                s.title LIKE ? OR
                u.email LIKE ? OR
                u.username LIKE ?
            )`);
            const searchTerm = `%${search}%`;
            params.push(searchTerm, searchTerm, searchTerm, searchTerm, searchTerm);
        }

        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const feedback = await dbAllAsync(`
            SELECT
                mf.id,
                mf.message_id,
                mf.session_id,
                mf.user_id,
                mf.rating,
                mf.comment,
                mf.created_at,
                mf.updated_at,
                m.content AS message_content,
                m.model AS message_model,
                s.title AS session_title,
                u.email AS user_email,
                u.username AS username
            FROM message_feedback mf
            JOIN messages m ON mf.message_id = m.id
            JOIN sessions s ON mf.session_id = s.id
            JOIN users u ON mf.user_id = u.id
            ${whereSql}
            ORDER BY mf.updated_at DESC, mf.id DESC
            LIMIT ? OFFSET ?
        `, [...params, limit, offset]);

        const totalRow = await dbGetAsync(`
            SELECT COUNT(*) AS count
            FROM message_feedback mf
            JOIN messages m ON mf.message_id = m.id
            JOIN sessions s ON mf.session_id = s.id
            JOIN users u ON mf.user_id = u.id
            ${whereSql}
        `, params);

        res.json({
            feedback,
            total: Number(totalRow?.count || 0),
            offset,
            limit
        });
    } catch (error) {
        console.error(' 获取反馈列表失败:', error);
        res.status(500).json({ error: '获取反馈列表失败' });
    }
});

// 获取所有用户列表
app.get('/api/admin/users', authenticateAdmin, (req, res) => {
    const offset = parseBoundedInteger(req.query.offset, 0, 0, 100000);
    const limit = parseBoundedInteger(req.query.limit, 50, 1, 100);

    db.all(`
        SELECT u.id, u.email, u.username, u.avatar_url, u.created_at, u.last_login,
               COALESCE(u.membership, 'free') as membership,
               u.membership_start, u.membership_end,
               COALESCE(u.points, 0) as points,
               COALESCE(u.purchased_points, 0) as purchased_points,
               (SELECT COUNT(*) FROM sessions WHERE user_id = u.id) as sessionCount,
               (SELECT COUNT(*) FROM messages m 
                JOIN sessions s ON m.session_id = s.id 
                WHERE s.user_id = u.id) as messageCount
        FROM users u
        ORDER BY u.created_at DESC
        LIMIT ? OFFSET ?
    `, [limit, offset], (err, users) => {
        if (err) {
            console.error(' 获取用户列表失败:', err);
            return res.status(500).json({ error: '获取用户列表失败' });
        }
        res.json({ users, offset, limit });
    });
});

// 管理员重置用户密码
app.put('/api/admin/users/:userId/password', authenticateAdmin, async (req, res) => {
    const userId = Number.parseInt(req.params.userId, 10);
    const newPassword = typeof req.body?.newPassword === 'string'
        ? req.body.newPassword
        : (typeof req.body?.password === 'string' ? req.body.password : '');

    if (!Number.isSafeInteger(userId) || userId <= 0) {
        return res.status(400).json({ error: '无效的用户ID' });
    }

    const passwordError = validatePasswordLength(newPassword, '新密码');
    if (passwordError) {
        return res.status(400).json({ error: passwordError });
    }

    try {
        const user = await dbGetAsync('SELECT id, email FROM users WHERE id = ?', [userId]);
        if (!user) {
            return res.status(404).json({ error: '用户不存在' });
        }

        const nextPasswordHash = await bcrypt.hash(newPassword, 10);
        await dbRunAsync('UPDATE users SET password_hash = ? WHERE id = ?', [nextPasswordHash, user.id]);
        console.log(` 管理员已重置用户密码: userId=${user.id}, email=${user.email}`);
        return res.json({ success: true, userId: user.id });
    } catch (error) {
        console.error(' 管理员重置用户密码失败:', error);
        return res.status(500).json({ error: '重置密码失败' });
    }
});

// 获取用户完整详情（包括会话列表）
app.get('/api/admin/users/:userId/detail', authenticateAdmin, async (req, res) => {
    const { userId } = req.params;

    try {
        // 获取用户基本信息
        const user = await new Promise((resolve, reject) => {
            db.get(`
                SELECT u.id, u.email, u.username, u.avatar_url, u.created_at, u.last_login,
                       COALESCE(u.membership, 'free') as membership,
                       u.membership_start, u.membership_end,
                       COALESCE(u.points, 0) as points,
                       COALESCE(u.purchased_points, 0) as purchased_points,
                       u.last_checkin, u.last_daily_grant,
                       (SELECT COUNT(*) FROM sessions WHERE user_id = u.id) as sessionCount,
                       (SELECT COUNT(*) FROM messages m 
                        JOIN sessions s ON m.session_id = s.id 
                        WHERE s.user_id = u.id) as messageCount
                FROM users u
                WHERE u.id = ?
            `, [userId], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        if (!user) {
            return res.status(404).json({ error: '用户不存在' });
        }

        // 获取用户所有会话列表
        const sessions = await new Promise((resolve, reject) => {
            db.all(`
                SELECT s.id, s.title, s.model, s.created_at, s.updated_at,
                       (SELECT COUNT(*) FROM messages WHERE session_id = s.id) as messageCount
                FROM sessions s
                WHERE s.user_id = ?
                ORDER BY s.updated_at DESC
            `, [userId], (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });

        res.json({ user, sessions });
    } catch (error) {
        console.error(' 获取用户详情失败:', error);
        res.status(500).json({ error: '获取用户详情失败' });
    }
});

// 获取指定会话的所有消息（完整内容）
app.get('/api/admin/sessions/:sessionId/messages', authenticateAdmin, async (req, res) => {
    const { sessionId } = req.params;
    const offset = parseBoundedInteger(req.query.offset, 0, 0, 100000);
    const limit = parseBoundedInteger(req.query.limit, 100, 1, 200);

    try {
        // 获取会话信息
        const session = await new Promise((resolve, reject) => {
            db.get(`
                SELECT s.id, s.title, s.model, s.created_at, s.updated_at, s.user_id,
                       u.email, u.username
                FROM sessions s
                JOIN users u ON s.user_id = u.id
                WHERE s.id = ?
            `, [sessionId], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        if (!session) {
            return res.status(404).json({ error: '会话不存在' });
        }

        // 获取消息总数
        const totalCount = await new Promise((resolve, reject) => {
            db.get('SELECT COUNT(*) as count FROM messages WHERE session_id = ?', [sessionId], (err, row) => {
                if (err) reject(err);
                else resolve(row?.count || 0);
            });
        });

        // 获取消息列表（完整内容，按时间正序排列便于阅读）
        const messages = await new Promise((resolve, reject) => {
            db.all(`
                SELECT id, role, content, reasoning_content, model, enable_search, 
                       thinking_mode, internet_mode, sources, process_trace, created_at
                FROM messages
                WHERE session_id = ?
                ORDER BY created_at ASC
                LIMIT ? OFFSET ?
            `, [sessionId, limit, offset], (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });

        res.json({ session, messages, totalCount, offset, limit });
    } catch (error) {
        console.error(' 获取会话消息失败:', error);
        res.status(500).json({ error: '获取会话消息失败' });
    }
});

// 获取指定用户的详细信息和消息
app.get('/api/admin/users/:userId/messages', authenticateAdmin, (req, res) => {
    const { userId } = req.params;
    const offset = parseBoundedInteger(req.query.offset, 0, 0, 100000);
    const limit = parseBoundedInteger(req.query.limit, 50, 1, 100);

    db.all(`
        SELECT m.id, m.session_id, m.role, m.content, m.model, m.created_at,
               s.title as session_title
        FROM messages m
        JOIN sessions s ON m.session_id = s.id
        WHERE s.user_id = ?
        ORDER BY m.created_at DESC
        LIMIT ? OFFSET ?
    `, [userId, limit, offset], (err, messages) => {
        if (err) {
            console.error(' 获取用户消息失败:', err);
            return res.status(500).json({ error: '获取用户消息失败' });
        }
        res.json({ messages, offset, limit });
    });
});

// 删除用户（及其所有数据）
app.delete('/api/admin/users/:userId', authenticateAdmin, async (req, res) => {
    const { userId } = req.params;

    try {
        const result = await deleteUserDataCascade(userId, { actor: 'admin' });
        if (!result.success) {
            return res.status(404).json({ error: '用户不存在' });
        }
        console.log(` 管理员删除用户 ID: ${userId}`);
        return res.json({
            success: true,
            deletedUserId: result.deletedUserId,
            deletedUploads: result.deletedUploads,
            deletedFiles: result.deletedFiles
        });
    } catch (err) {
        console.error(' 删除用户失败:', err);
        return res.status(500).json({ error: '删除用户失败' });
    }
});

// 管理员设置用户会员等级
app.put('/api/admin/users/:userId/membership', authenticateAdmin, (req, res) => {
    const { userId } = req.params;
    const { membership, months } = req.body;

    // 验证会员等级
    if (!['free', 'Pro', 'MAX'].includes(membership)) {
        return res.status(400).json({ error: '无效的会员等级，必须是 free/Pro/MAX' });
    }

    let membershipStart = null;
    let membershipEnd = null;

    if (membership !== 'free' && months > 0) {
        membershipStart = new Date().toISOString();
        const endDate = new Date();
        endDate.setMonth(endDate.getMonth() + parseInt(months));
        membershipEnd = endDate.toISOString();
    }

    db.run(`
        UPDATE users SET 
            membership = ?,
            membership_start = ?,
            membership_end = ?
        WHERE id = ?
    `, [membership, membershipStart, membershipEnd, userId], function (err) {
        if (err) {
            console.error(' 设置会员失败:', err);
            return res.status(500).json({ error: '设置会员失败' });
        }
        if (this.changes === 0) {
            return res.status(404).json({ error: '用户不存在' });
        }
        console.log(` 管理员设置用户 ${userId} 会员为 ${membership}，时长 ${months || 0} 个月`);
        res.json({ success: true, membership, membershipStart, membershipEnd });
    });
});

// 管理员添加/扣减点数
app.put('/api/admin/users/:userId/points', authenticateAdmin, (req, res) => {
    const { userId } = req.params;
    const { points, type, expireYears } = req.body;
    // type: 'daily' 或 'purchased'

    if (typeof points !== 'number') {
        return res.status(400).json({ error: '点数必须是数字' });
    }

    if (type === 'purchased') {
        // 购买的点数
        let expireDate = null;
        if (expireYears && expireYears > 0) {
            const date = new Date();
            date.setFullYear(date.getFullYear() + expireYears);
            expireDate = date.toISOString();
        }

        db.run(`
            UPDATE users SET 
                purchased_points = COALESCE(purchased_points, 0) + ?,
                purchased_points_expire = COALESCE(?, purchased_points_expire)
            WHERE id = ?
        `, [points, expireDate, userId], function (err) {
            if (err) {
                console.error(' 添加购买点数失败:', err);
                return res.status(500).json({ error: '添加点数失败' });
            }
            if (this.changes === 0) {
                return res.status(404).json({ error: '用户不存在' });
            }
            console.log(` 管理员给用户 ${userId} 添加 ${points} 购买点数`);
            res.json({ success: true, pointsAdded: points, type: 'purchased' });
        });
    } else {
        // 每日点数
        db.run(`
            UPDATE users SET points = COALESCE(points, 0) + ? WHERE id = ?
        `, [points, userId], function (err) {
            if (err) {
                console.error(' 添加每日点数失败:', err);
                return res.status(500).json({ error: '添加点数失败' });
            }
            if (this.changes === 0) {
                return res.status(404).json({ error: '用户不存在' });
            }
            console.log(` 管理员给用户 ${userId} 添加 ${points} 每日点数`);
            res.json({ success: true, pointsAdded: points, type: 'daily' });
        });
    }
});

// 获取所有消息（带分页和筛选）
app.get('/api/admin/messages', authenticateAdmin, (req, res) => {
    const offset = parseBoundedInteger(req.query.offset, 0, 0, 100000);
    const limit = parseBoundedInteger(req.query.limit, 50, 1, 100);
    const search = req.query.search || '';
    const userId = req.query.userId || '';

    let query = `
        SELECT m.id, m.session_id, m.role, m.content, m.model, m.created_at,
               s.title as session_title, u.username, u.email
        FROM messages m
        JOIN sessions s ON m.session_id = s.id
        JOIN users u ON s.user_id = u.id
        WHERE 1=1
    `;
    const params = [];

    if (search) {
        query += ' AND m.content LIKE ?';
        params.push(`%${search}%`);
    }

    if (userId) {
        query += ' AND u.id = ?';
        params.push(userId);
    }

    query += ' ORDER BY m.created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    db.all(query, params, (err, messages) => {
        if (err) {
            console.error(' 获取消息列表失败:', err);
            return res.status(500).json({ error: '获取消息列表失败' });
        }
        res.json({ messages, offset, limit });
    });
});

// 删除消息
app.delete('/api/admin/messages/:messageId', authenticateAdmin, (req, res) => {
    const { messageId } = req.params;

    db.run('DELETE FROM messages WHERE id = ?', [messageId], function (err) {
        if (err) {
            console.error(' 删除消息失败:', err);
            return res.status(500).json({ error: '删除消息失败' });
        }
        if (this.changes === 0) {
            return res.status(404).json({ error: '消息不存在' });
        }
        console.log(` 管理员删除消息 ID: ${messageId}`);
        res.json({ success: true, deletedMessageId: messageId });
    });
});

// 获取所有会话
app.get('/api/admin/sessions', authenticateAdmin, (req, res) => {
    const offset = parseBoundedInteger(req.query.offset, 0, 0, 100000);
    const limit = parseBoundedInteger(req.query.limit, 50, 1, 100);

    db.all(`
        SELECT s.id, s.title, s.model, s.created_at, s.updated_at,
               u.username, u.email,
               (SELECT COUNT(*) FROM messages WHERE session_id = s.id) as messageCount
        FROM sessions s
        JOIN users u ON s.user_id = u.id
        ORDER BY s.updated_at DESC
        LIMIT ? OFFSET ?
    `, [limit, offset], (err, sessions) => {
        if (err) {
            console.error(' 获取会话列表失败:', err);
            return res.status(500).json({ error: '获取会话列表失败' });
        }
        res.json({ sessions, offset, limit });
    });
});

// 删除会话
app.delete('/api/admin/sessions/:sessionId', authenticateAdmin, async (req, res) => {
    const { sessionId } = req.params;

    try {
        await dbRunAsync('BEGIN IMMEDIATE TRANSACTION');
        await dbRunAsync('DELETE FROM messages WHERE session_id = ?', [sessionId]);
        const result = await dbRunAsync('DELETE FROM sessions WHERE id = ?', [sessionId]);
        if (result.changes === 0) {
            await dbRunAsync('ROLLBACK');
            return res.status(404).json({ error: '会话不存在' });
        }
        await dbRunAsync('COMMIT');
        console.log(` 管理员删除会话 ID: ${sessionId}`);
        return res.json({ success: true, deletedSessionId: sessionId });
    } catch (err) {
        await dbRunAsync('ROLLBACK').catch(() => null);
        console.error(' 删除会话失败:', err);
        return res.status(500).json({ error: '删除会话失败' });
    }
});

// ==================== 404处理 ====================
app.use((req, res) => {
    const isApiRequest = String(req.path || '').startsWith('/api');
    res.status(404).json({
        success: false,
        error: isApiRequest ? '接口不存在或前端版本过旧，请刷新后重试' : '路由未找到',
        code: isApiRequest ? 'api_not_found' : 'route_not_found',
        path: req.path,
        method: req.method
    });
});

// ==================== 错误处理 ====================
app.use((err, req, res, next) => {
    if (err && err.message === 'CORS origin not allowed') {
        return res.status(403).json({
            error: 'CORS origin not allowed',
            requestId: req.headers['x-request-id'] || null
        });
    }

    console.error(' 服务器错误:', err);
    const isProd = process.env.NODE_ENV === 'production';
    const payload = {
        error: '服务器内部错误',
        requestId: req.headers['x-request-id'] || null
    };
    if (!isProd) {
        payload.message = err.message;
    }
    res.status(500).json(payload);
});

// ==================== 启动服务器 ====================
app.listen(PORT, HOST, () => {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║                                                          ║
║             RAI v${PACKAGE_VERSION} 已启动                      ║
║                                                          ║
║   服务地址: http://${HOST}:${PORT}                     ║
║   数据库: ${dbPath}                                    ║
║   JWT认证:                                          ║
║   AI提供商: Tavily + 流动硅基                           ║
║   思考模式:                                          ║
║   停止输出:                                          ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
  `);

    db.get('SELECT COUNT(*) as count FROM users', (err, row) => {
        if (!err) {
            console.log(` 数据库正常, 当前用户数: ${row.count}`);
        }
    });
});

// 优雅退出
process.on('SIGTERM', () => {
    console.log(' 收到SIGTERM信号,准备关闭服务器');
    db.close((err) => {
        if (err) console.error(' 关闭数据库失败:', err);
        else console.log(' 数据库已关闭');
        process.exit(0);
    });
});
