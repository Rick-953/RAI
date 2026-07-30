'use strict';

const crypto = require('crypto');

const PREFIX = 'enc:v1';
const KEY_BYTES = 32;

function normalizeKeyMaterial(material) {
    const raw = String(material || '').trim();
    if (!raw) return null;
    if (/^[a-f0-9]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
    try {
        const decoded = Buffer.from(raw, 'base64');
        if (decoded.length === KEY_BYTES && decoded.toString('base64').replace(/=+$/, '') === raw.replace(/=+$/, '')) {
            return decoded;
        }
    } catch (_) {}
    if (Buffer.byteLength(raw, 'utf8') < 32) return null;
    return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(raw, 'utf8'), Buffer.from('RAI-TOTP-secret-store'), Buffer.from('aes-256-gcm-v1'), KEY_BYTES));
}

function keyIdentifier(key) {
    return crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
}

function sanitizeAadPart(value, label) {
    const text = String(value || '').trim();
    if (!text || text.length > 160 || /[\r\n|:]/.test(text)) throw new Error(`invalid_totp_${label}`);
    return text;
}

function buildAad(purpose, recordId) {
    return Buffer.from(`RAI|totp|v1|${sanitizeAadPart(purpose, 'purpose')}|${sanitizeAadPart(recordId, 'record_id')}`, 'utf8');
}

function createTotpSecretCipher(materials = []) {
    const keys = [];
    for (const material of materials) {
        const key = normalizeKeyMaterial(material);
        if (!key) continue;
        const id = keyIdentifier(key);
        if (!keys.some((item) => item.id === id)) keys.push({ id, key });
    }
    if (keys.length === 0) throw new Error('totp_encryption_key_missing');
    const primary = keys[0];

    function encrypt(secret, options = {}) {
        const value = String(secret || '').trim();
        if (!value) return '';
        const purpose = sanitizeAadPart(options.purpose, 'purpose');
        const recordId = sanitizeAadPart(options.recordId, 'record_id');
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', primary.key, iv);
        cipher.setAAD(buildAad(purpose, recordId));
        const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
        const tag = cipher.getAuthTag();
        return [PREFIX, primary.id, purpose, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join(':');
    }

    function decrypt(storedValue, options = {}) {
        const value = String(storedValue || '').trim();
        if (!value) return '';
        if (!value.startsWith(`${PREFIX}:`)) {
            if (options.allowPlaintext === true) return value;
            throw new Error('totp_secret_plaintext_rejected');
        }
        const parts = value.split(':');
        if (parts.length !== 7 || `${parts[0]}:${parts[1]}` !== PREFIX) throw new Error('totp_ciphertext_format_invalid');
        const [, , keyId, purpose, ivText, tagText, ciphertextText] = parts;
        const expectedPurpose = sanitizeAadPart(options.purpose, 'purpose');
        const recordId = sanitizeAadPart(options.recordId, 'record_id');
        if (purpose !== expectedPurpose) throw new Error('totp_ciphertext_purpose_mismatch');
        const iv = Buffer.from(ivText, 'base64url');
        const tag = Buffer.from(tagText, 'base64url');
        const ciphertext = Buffer.from(ciphertextText, 'base64url');
        if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) throw new Error('totp_ciphertext_format_invalid');
        const candidates = keys.filter((item) => item.id === keyId);
        if (candidates.length === 0) throw new Error('totp_encryption_key_unknown');
        for (const candidate of candidates) {
            try {
                const decipher = crypto.createDecipheriv('aes-256-gcm', candidate.key, iv);
                decipher.setAAD(buildAad(purpose, recordId));
                decipher.setAuthTag(tag);
                return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
            } catch (_) {}
        }
        throw new Error('totp_ciphertext_authentication_failed');
    }

    return {
        encrypt,
        decrypt,
        isEncrypted(value) {
            return String(value || '').startsWith(`${PREFIX}:`);
        },
        primaryKeyId: primary.id
    };
}

module.exports = {
    createTotpSecretCipher,
    normalizeKeyMaterial
};
