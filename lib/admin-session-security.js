'use strict';

const crypto = require('crypto');

const ADMIN_CREDENTIAL_VERSION_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ADMIN_CREDENTIAL_VERSION_CONTEXT = 'rai-admin-credential-version-v1';

function requireCredentialComponent(value, label, minLength = 1) {
    const normalized = String(value || '').trim();
    if (normalized.length < minLength) {
        throw new TypeError(`${label}_is_required`);
    }
    return normalized;
}

function deriveAdminCredentialVersion({ passwordHash, totpSecret = '', jwtSecret } = {}) {
    const normalizedPasswordHash = requireCredentialComponent(passwordHash, 'admin_password_hash', 20);
    const normalizedJwtSecret = requireCredentialComponent(jwtSecret, 'admin_jwt_secret', 32);
    const normalizedTotpSecret = String(totpSecret || '').replace(/[\s=:-]/g, '').toUpperCase();

    return crypto
        .createHmac('sha256', normalizedJwtSecret)
        .update(ADMIN_CREDENTIAL_VERSION_CONTEXT, 'utf8')
        .update('\0', 'utf8')
        .update(normalizedPasswordHash, 'utf8')
        .update('\0', 'utf8')
        .update(normalizedTotpSecret, 'utf8')
        .digest('base64url');
}

function isAdminCredentialVersion(value) {
    return ADMIN_CREDENTIAL_VERSION_PATTERN.test(String(value || ''));
}

function adminCredentialVersionMatches(candidate, expected) {
    const left = String(candidate || '');
    const right = String(expected || '');
    if (!isAdminCredentialVersion(left) || !isAdminCredentialVersion(right)) return false;
    return crypto.timingSafeEqual(Buffer.from(left, 'ascii'), Buffer.from(right, 'ascii'));
}

module.exports = {
    ADMIN_CREDENTIAL_VERSION_PATTERN,
    adminCredentialVersionMatches,
    deriveAdminCredentialVersion,
    isAdminCredentialVersion
};
