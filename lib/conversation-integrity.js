'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CONVERSATION_SCHEMA = 'rai-conversation/v1';
const RECEIPT_SCHEMA = 'rai-conversation-receipt/v1';

function parseJson(value, fallback) {
    if (value === null || value === undefined || value === '') return fallback;
    if (typeof value === 'object') return value;
    try { return JSON.parse(String(value)); } catch (_) { return fallback; }
}

function canonicalize(value) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (Array.isArray(value)) return value.map(canonicalize);
    if (!value || typeof value !== 'object') return String(value ?? '');
    const normalized = {};
    for (const key of Object.keys(value).sort()) {
        if (value[key] !== undefined) normalized[key] = canonicalize(value[key]);
    }
    return normalized;
}

function canonicalJson(value) {
    return JSON.stringify(canonicalize(value));
}

function normalizeAttachment(value = {}) {
    return {
        type: String(value.type || ''),
        fileName: String(value.fileName || value.originalName || ''),
        mimeType: String(value.mimeType || value.fileType || ''),
        size: Math.max(0, Number(value.size || 0))
    };
}

function normalizeSources(value) {
    const parsed = parseJson(value, []);
    return Array.isArray(parsed) ? canonicalize(parsed) : [];
}

function buildConversationDocument({ session, messages = [], issuer }) {
    if (!session?.id) throw new Error('conversation_session_required');
    return {
        schema: CONVERSATION_SCHEMA,
        issuer: String(issuer || ''),
        conversation: {
            id: String(session.id),
            title: String(session.title || ''),
            createdAt: session.created_at || session.createdAt || null,
            updatedAt: session.updated_at || session.updatedAt || null,
            messages: messages.map((message, index) => ({
                ordinal: index + 1,
                id: Number.isSafeInteger(Number(message.id)) ? Number(message.id) : String(message.id || ''),
                role: String(message.role || ''),
                content: String(message.content || ''),
                attachments: (Array.isArray(parseJson(message.attachments, []))
                    ? parseJson(message.attachments, [])
                    : []).map(normalizeAttachment),
                model: String(message.model || ''),
                sources: normalizeSources(message.sources),
                createdAt: message.created_at || message.createdAt || null
            }))
        }
    };
}

function publicKeyFingerprint(publicKey) {
    const key = publicKey?.type === 'public' ? publicKey : crypto.createPublicKey(publicKey);
    const der = key.export({ type: 'spki', format: 'der' });
    return crypto.createHash('sha256').update(der).digest('hex');
}

function loadConversationSigner(privateKeyPath) {
    const resolved = path.resolve(String(privateKeyPath || ''));
    if (!privateKeyPath || !fs.existsSync(resolved)) {
        const error = new Error('conversation_signing_key_unavailable');
        error.code = 'conversation_signing_key_unavailable';
        throw error;
    }
    const privateKey = crypto.createPrivateKey(fs.readFileSync(resolved));
    if (privateKey.asymmetricKeyType !== 'ed25519') {
        const error = new Error('conversation_signing_key_must_be_ed25519');
        error.code = 'conversation_signing_key_invalid';
        throw error;
    }
    const publicKey = crypto.createPublicKey(privateKey);
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    return Object.freeze({
        privateKey,
        publicKey,
        publicKeyPem,
        keyId: publicKeyFingerprint(publicKey)
    });
}

function receiptSigningPayload(receipt) {
    return canonicalJson({
        schema: receipt.schema,
        issuer: receipt.issuer,
        conversationId: receipt.conversationId,
        messagesRevision: receipt.messagesRevision,
        messageCount: receipt.messageCount,
        digestAlgorithm: receipt.digestAlgorithm,
        digest: receipt.digest,
        signedAt: receipt.signedAt,
        keyId: receipt.keyId
    });
}

function createConversationReceipt({ document, messagesRevision, signer, signedAt = new Date().toISOString() }) {
    if (!signer?.privateKey || !signer?.publicKeyPem) throw new Error('conversation_signer_required');
    const digest = crypto.createHash('sha256').update(canonicalJson(document), 'utf8').digest('hex');
    const receipt = {
        schema: RECEIPT_SCHEMA,
        issuer: String(document?.issuer || ''),
        conversationId: String(document?.conversation?.id || ''),
        messagesRevision: Math.max(0, Number(messagesRevision || 0)),
        messageCount: Array.isArray(document?.conversation?.messages) ? document.conversation.messages.length : 0,
        digestAlgorithm: 'SHA-256',
        digest,
        signatureAlgorithm: 'Ed25519',
        signedAt,
        keyId: signer.keyId,
        publicKey: signer.publicKeyPem
    };
    receipt.signature = crypto.sign(null, Buffer.from(receiptSigningPayload(receipt), 'utf8'), signer.privateKey).toString('base64');
    return receipt;
}

function verifyConversationReceipt({ document, receipt, trustedKeyId = '' }) {
    try {
        if (receipt?.schema !== RECEIPT_SCHEMA || receipt?.digestAlgorithm !== 'SHA-256' || receipt?.signatureAlgorithm !== 'Ed25519') {
            return { authentic: false, reason: 'receipt_contract_invalid' };
        }
        const digest = crypto.createHash('sha256').update(canonicalJson(document), 'utf8').digest('hex');
        if (digest !== receipt.digest) return { authentic: false, reason: 'conversation_digest_mismatch', digest };
        const key = crypto.createPublicKey(receipt.publicKey);
        const keyId = publicKeyFingerprint(key);
        if (keyId !== receipt.keyId || (trustedKeyId && keyId !== trustedKeyId)) {
            return { authentic: false, reason: 'signing_key_untrusted', digest, keyId };
        }
        const signatureValid = crypto.verify(
            null,
            Buffer.from(receiptSigningPayload(receipt), 'utf8'),
            key,
            Buffer.from(String(receipt.signature || ''), 'base64')
        );
        return { authentic: signatureValid, reason: signatureValid ? 'verified' : 'signature_invalid', digest, keyId };
    } catch (_) {
        return { authentic: false, reason: 'receipt_unreadable' };
    }
}

async function writeJsonFileExclusive(filePath, value) {
    const serialized = `${JSON.stringify(value)}\n`;
    try {
        await fs.promises.writeFile(filePath, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const existing = await fs.promises.readFile(filePath, 'utf8');
        if (existing !== serialized) throw new Error('conversation_ledger_conflict');
    }
}

async function writeReceiptDirectory(rootDir, receipt) {
    const resolvedRoot = path.resolve(String(rootDir || ''));
    if (!rootDir || resolvedRoot === path.parse(resolvedRoot).root) throw new Error('conversation_ledger_path_invalid');
    const sessionKey = crypto.createHash('sha256').update(receipt.conversationId, 'utf8').digest('hex');
    const sessionDir = path.join(resolvedRoot, sessionKey.slice(0, 2), sessionKey);
    await fs.promises.mkdir(sessionDir, { recursive: true, mode: 0o700 });
    const immutableName = `${String(receipt.messagesRevision).padStart(12, '0')}-${receipt.digest}.json`;
    await writeJsonFileExclusive(path.join(sessionDir, immutableName), receipt);
    const currentPath = path.join(sessionDir, 'current.json');
    const temporaryPath = path.join(sessionDir, `.current-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`);
    await fs.promises.writeFile(temporaryPath, `${JSON.stringify(receipt)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fs.promises.rename(temporaryPath, currentPath);
    return { root: resolvedRoot, file: path.join(sessionDir, immutableName) };
}

async function writeConversationReceiptLedgers({ receipt, primaryDir, mirrorDir = '' }) {
    const primary = await writeReceiptDirectory(primaryDir, receipt);
    let mirror = null;
    let mirrorError = null;
    if (mirrorDir) {
        try {
            const mirrorStat = await fs.promises.lstat(path.resolve(mirrorDir));
            if (!mirrorStat.isDirectory() || mirrorStat.isSymbolicLink()) throw new Error('conversation_mirror_unavailable');
            mirror = await writeReceiptDirectory(mirrorDir, receipt);
        }
        catch (error) {
            mirrorError = error?.code === 'ENOENT'
                ? 'conversation_mirror_unavailable'
                : (error?.code || error?.message || 'mirror_write_failed');
        }
    }
    return { primary, mirror, mirrorError };
}

module.exports = Object.freeze({
    CONVERSATION_SCHEMA,
    RECEIPT_SCHEMA,
    buildConversationDocument,
    canonicalJson,
    createConversationReceipt,
    loadConversationSigner,
    publicKeyFingerprint,
    verifyConversationReceipt,
    writeConversationReceiptLedgers
});
