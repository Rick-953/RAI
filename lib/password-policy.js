'use strict';

const crypto = require('crypto');
const bcrypt = require('bcrypt');

const PASSWORD_POLICY_VERSION = 2;
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 128;
const PASSWORD_MAX_BYTES = 1024;
const PASSWORD_HASH_PREFIX = 'rai-pw-v2$';
const PWNED_PASSWORD_RANGE_ENDPOINT = 'https://api.pwnedpasswords.com/range';
const PWNED_RANGE_MAX_BYTES = 256 * 1024;
const PWNED_RANGE_CACHE_TTL_MS = 15 * 60 * 1000;
const pwnedRangeCache = new Map();

async function readBoundedResponseBuffer(response, maxBytes) {
    const limit = Math.max(1, Number(maxBytes) || 1);
    const declaredLength = Number(response?.headers?.get?.('content-length') || 0);
    if (declaredLength > limit) {
        await response?.body?.cancel?.().catch(() => null);
        throw new Error('pwned_range_response_too_large');
    }
    const reader = response?.body?.getReader?.();
    if (!reader) throw new Error('pwned_range_response_not_streamable');
    const chunks = [];
    let total = 0;
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        total += chunk.length;
        if (total > limit) {
            await reader.cancel().catch(() => null);
            throw new Error('pwned_range_response_too_large');
        }
        chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
}

const COMMON_PASSWORDS = new Set([
    '123456', '12345678', '123456789', '1234567890', '111111', '000000',
    'password', 'password1', 'password123', 'passw0rd', 'qwerty', 'qwerty123',
    'abc123', 'admin', 'administrator', 'welcome', 'welcome123', 'letmein',
    'iloveyou', 'monkey', 'dragon', 'football', 'baseball', 'sunshine', 'princess',
    'trustno1', 'login', 'user', 'guest', 'changeme', 'secret', 'master',
    '123123', '654321', '666666', '888888', '1q2w3e4r', 'qwertyuiop',
    'asdfghjkl', 'zaq12wsx', 'password!', 'p@ssw0rd', 'p@ssword123',
    'correcthorsebatterystaple', 'raipassword', 'rick953'
]);

function passwordLength(value) {
    return Array.from(String(value || '')).length;
}

function validateExistingPasswordInput(password, fieldLabel = '密码') {
    if (typeof password !== 'string' || password.length === 0) return `${fieldLabel}不能为空`;
    if (passwordLength(password) > PASSWORD_MAX_LENGTH || Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) {
        return `${fieldLabel}不能超过${PASSWORD_MAX_LENGTH}个字符`;
    }
    return '';
}

function canonicalWeakPassword(value) {
    return String(value || '').normalize('NFKC').toLocaleLowerCase('en-US').replace(/[\s._-]+/g, '');
}

function validateNewPasswordPolicy(password, context = {}, fieldLabel = '密码') {
    if (typeof password !== 'string') return `${fieldLabel}至少需要${PASSWORD_MIN_LENGTH}个字符`;
    const length = passwordLength(password);
    if (length < PASSWORD_MIN_LENGTH) return `${fieldLabel}至少需要${PASSWORD_MIN_LENGTH}个字符`;
    if (length > PASSWORD_MAX_LENGTH || Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) {
        return `${fieldLabel}不能超过${PASSWORD_MAX_LENGTH}个字符`;
    }
    const canonical = canonicalWeakPassword(password);
    if (!canonical || COMMON_PASSWORDS.has(canonical)) return `${fieldLabel}过于常见，请换一个更难猜的密码`;
    if (/^(.)\1{7,}$/u.test(canonical) || /(?:0123456789|1234567890|abcdefghijklmnopqrstuvwxyz|qwertyuiop)/i.test(canonical)) {
        return `${fieldLabel}包含容易猜到的重复或连续内容`;
    }
    const personalValues = [context.email, context.username]
        .map((value) => canonicalWeakPassword(String(value || '').split('@')[0]))
        .filter((value) => value.length >= 4);
    if (personalValues.some((value) => canonical.includes(value))) {
        return `${fieldLabel}不能包含邮箱或用户名中的明显片段`;
    }
    return '';
}

function prehashPassword(password) {
    return crypto.createHash('sha512').update(Buffer.from(String(password), 'utf8')).digest('base64url');
}

async function checkPasswordCompromise(password, options = {}) {
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== 'function') return { checked: false, compromised: false, count: 0 };
    const sha1 = crypto.createHash('sha1').update(Buffer.from(String(password), 'utf8')).digest('hex').toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);
    const now = Number(options.now || Date.now());
    let suffixCounts = null;
    const cached = pwnedRangeCache.get(prefix);
    if (cached && cached.expiresAt > now) suffixCounts = cached.suffixCounts;

    if (!suffixCounts) {
        const controller = new AbortController();
        const timeoutMs = Math.max(500, Math.min(Number(options.timeoutMs) || 2500, 10000));
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const endpoint = String(options.endpoint || PWNED_PASSWORD_RANGE_ENDPOINT).replace(/\/+$/, '');
            const response = await fetchImpl(`${endpoint}/${prefix}`, {
                method: 'GET',
                headers: {
                    Accept: 'text/plain',
                    'Add-Padding': 'true',
                    'User-Agent': 'RAI-password-policy'
                },
                redirect: 'error',
                signal: controller.signal
            });
            if (!response?.ok) return { checked: false, compromised: false, count: 0 };
            const bytes = await readBoundedResponseBuffer(response, PWNED_RANGE_MAX_BYTES);
            suffixCounts = new Map();
            for (const line of bytes.toString('utf8').split(/\r?\n/)) {
                const match = line.trim().match(/^([A-F0-9]{35}):(\d+)$/i);
                if (!match) continue;
                const count = Number(match[2]);
                if (Number.isSafeInteger(count) && count > 0) suffixCounts.set(match[1].toUpperCase(), count);
            }
            if (pwnedRangeCache.size >= 256) {
                const oldestKey = pwnedRangeCache.keys().next().value;
                if (oldestKey) pwnedRangeCache.delete(oldestKey);
            }
            pwnedRangeCache.set(prefix, { suffixCounts, expiresAt: now + PWNED_RANGE_CACHE_TTL_MS });
        } catch (_) {
            return { checked: false, compromised: false, count: 0 };
        } finally {
            clearTimeout(timeoutId);
        }
    }

    const count = Number(suffixCounts.get(suffix) || 0);
    return { checked: true, compromised: count > 0, count };
}

async function hashPassword(password, rounds = 11) {
    const digest = prehashPassword(password);
    return `${PASSWORD_HASH_PREFIX}${await bcrypt.hash(digest, rounds)}`;
}

async function verifyPassword(password, storedHash) {
    const value = String(storedHash || '');
    if (value.startsWith(PASSWORD_HASH_PREFIX)) {
        return bcrypt.compare(prehashPassword(password), value.slice(PASSWORD_HASH_PREFIX.length));
    }
    return bcrypt.compare(String(password), value);
}

function isCurrentPasswordHash(storedHash) {
    return String(storedHash || '').startsWith(PASSWORD_HASH_PREFIX);
}

module.exports = {
    PASSWORD_HASH_PREFIX,
    PASSWORD_MAX_LENGTH,
    PASSWORD_MIN_LENGTH,
    PASSWORD_POLICY_VERSION,
    checkPasswordCompromise,
    hashPassword,
    isCurrentPasswordHash,
    validateExistingPasswordInput,
    validateNewPasswordPolicy,
    verifyPassword
};
