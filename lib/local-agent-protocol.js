'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { canonicalJson, publicKeyFingerprint } = require('./conversation-integrity');

const PROTOCOL_VERSION = 1;
const PAIRING_TTL_SECONDS = 5 * 60;
const SESSION_IDLE_SECONDS = 30 * 60;
const SESSION_ABSOLUTE_SECONDS = 4 * 60 * 60;
const CLOUD_OUTPUT_BYTES = 64 * 1024;
const MODEL_OUTPUT_BYTES = 128 * 1024;
const DEVICE_ID_PATTERN = /^agent_[a-f0-9]{32}$/;
const PAIRING_ID_PATTERN = /^pair_[a-f0-9]{32}$/;
const SESSION_ID_PATTERN = /^las_[a-f0-9]{32}$/;
const RUN_ID_PATTERN = /^lar_[a-f0-9]{32}$/;
const TOOL_CALL_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,160}$/;
const CAPABILITIES = new Set(['filesystem', 'process', 'browser', 'audit']);

function runAsync(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(error) {
            if (error) reject(error);
            else resolve({ changes: Number(this.changes || 0), lastID: this.lastID });
        });
    });
}

function getAsync(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (error, row) => {
            if (error) reject(error);
            else resolve(row || null);
        });
    });
}

function allAsync(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (error, rows) => {
            if (error) reject(error);
            else resolve(Array.isArray(rows) ? rows : []);
        });
    });
}

function randomId(prefix) {
    return `${prefix}_${crypto.randomBytes(16).toString('hex')}`;
}

function nowSeconds(now) {
    return Math.floor(Number(now()) / 1000);
}

function normalizeText(value, maxLength, fallback = '') {
    const text = String(value || '')
        .normalize('NFKC')
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return (text || fallback).slice(0, maxLength);
}

function normalizeCapabilities(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map((item) => String(item || '').trim()).filter((item) => CAPABILITIES.has(item)))].sort();
}

function normalizePlatform(value) {
    const platform = String(value || '').trim().toLowerCase();
    if (!['macos', 'linux', 'windows'].includes(platform)) throw protocolError('invalid_platform', 400);
    return platform;
}

function protocolError(code, statusCode = 400) {
    const error = new Error(code);
    error.code = code;
    error.statusCode = statusCode;
    return error;
}

function parsePublicKey(value) {
    let der;
    try {
        der = Buffer.from(String(value || ''), 'base64');
    } catch (_) {
        throw protocolError('invalid_device_public_key');
    }
    if (der.length < 32 || der.length > 128) throw protocolError('invalid_device_public_key');
    let publicKey;
    try {
        publicKey = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    } catch (_) {
        throw protocolError('invalid_device_public_key');
    }
    if (publicKey.asymmetricKeyType !== 'ed25519') throw protocolError('device_key_must_be_ed25519');
    return { publicKey, der, encoded: der.toString('base64'), fingerprint: publicKeyFingerprint(publicKey) };
}

function verifySignature(publicKeyBase64, payload, signatureBase64) {
    try {
        const { publicKey } = parsePublicKey(publicKeyBase64);
        const signature = Buffer.from(String(signatureBase64 || ''), 'base64');
        if (signature.length !== 64) return false;
        return crypto.verify(null, Buffer.from(String(payload), 'utf8'), publicKey, signature);
    } catch (_) {
        return false;
    }
}

function loadSigner(primaryPath, fallbackPath = '') {
    const selected = [primaryPath, fallbackPath]
        .map((value) => String(value || '').trim())
        .find((value) => value && fs.existsSync(path.resolve(value)));
    if (!selected) return null;
    const privateKey = crypto.createPrivateKey(fs.readFileSync(path.resolve(selected)));
    if (privateKey.asymmetricKeyType !== 'ed25519') throw protocolError('local_agent_signing_key_invalid', 500);
    const publicKey = crypto.createPublicKey(privateKey);
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    return Object.freeze({
        privateKey,
        publicKey,
        publicKeyPem,
        keyId: publicKeyFingerprint(publicKey)
    });
}

function hashChallenge(value) {
    return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function truncateUtf8(value, maxBytes) {
    const text = String(value || '');
    if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false };
    const side = Math.floor((maxBytes - 96) / 2);
    const take = (source, fromEnd) => {
        let result = fromEnd ? source.slice(-side) : source.slice(0, side);
        while (Buffer.byteLength(result, 'utf8') > side) result = fromEnd ? result.slice(1) : result.slice(0, -1);
        return result;
    };
    return {
        text: `${take(text, false)}\n\n[RAI_LOCAL_OUTPUT_TRUNCATED]\n\n${take(text, true)}`,
        truncated: true
    };
}

function redactSecrets(value) {
    return String(value || '')
        .replace(/((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
        .replace(/\b(?:sk|rai_app_v1)_[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_TOKEN]')
        .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [REDACTED]');
}

function normalizeToolResult(result = {}, maxBytes = MODEL_OUTPUT_BYTES) {
    const output = redactSecrets(result.output ?? result.stdout ?? result.text ?? result.message ?? '');
    const stderr = redactSecrets(result.stderr ?? '');
    const combined = stderr ? `${output}${output ? '\n' : ''}[stderr]\n${stderr}` : output;
    const clipped = truncateUtf8(combined, maxBytes);
    return {
        success: result.success !== false && !result.error,
        output: clipped.text,
        exit_code: Number.isInteger(Number(result.exit_code ?? result.exitCode)) ? Number(result.exit_code ?? result.exitCode) : null,
        error: result.error ? normalizeText(result.error, 160, 'agent_execution_failed') : null,
        truncated: clipped.truncated || result.truncated === true,
        full_output_available: result.full_output_available === true || result.fullOutputAvailable === true,
        output_sha256: crypto.createHash('sha256').update(combined, 'utf8').digest('hex')
    };
}

function rowToDevice(row) {
    return {
        id: String(row.id),
        name: String(row.name || 'RAI Agent'),
        platform: String(row.platform || ''),
        agentVersion: String(row.agent_version || ''),
        protocolVersion: Number(row.protocol_version || 0),
        capabilities: JSON.parse(String(row.capabilities_json || '[]')),
        createdAt: Number(row.created_at || 0),
        lastSeenAt: Number(row.last_seen_at || 0),
        revokedAt: row.revoked_at == null ? null : Number(row.revoked_at)
    };
}

function createLocalAgentService({
    db,
    signingKeyPath = '',
    fallbackSigningKeyPath = '',
    issuer = '',
    now = () => Date.now()
} = {}) {
    if (!db || typeof db.run !== 'function') throw new TypeError('sqlite database required');
    const signer = loadSigner(signingKeyPath, fallbackSigningKeyPath);

    async function migrate() {
        await runAsync(db, `CREATE TABLE IF NOT EXISTS agent_devices (
            id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            public_key TEXT NOT NULL,
            key_fingerprint TEXT NOT NULL,
            name TEXT NOT NULL,
            platform TEXT NOT NULL,
            agent_version TEXT NOT NULL,
            protocol_version INTEGER NOT NULL,
            capabilities_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            last_seen_at INTEGER NOT NULL,
            revoked_at INTEGER,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            UNIQUE(user_id, key_fingerprint)
        )`);
        await runAsync(db, `CREATE TABLE IF NOT EXISTS agent_pairing_challenges (
            id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            public_key TEXT NOT NULL,
            key_fingerprint TEXT NOT NULL,
            device_json TEXT NOT NULL,
            challenge_hash TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            consumed_at INTEGER,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )`);
        await runAsync(db, `CREATE TABLE IF NOT EXISTS agent_sessions (
            id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            agent_device_id TEXT NOT NULL,
            conversation_id TEXT,
            challenge_hash TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('pending','active','closed')),
            created_at INTEGER NOT NULL,
            accepted_at INTEGER,
            last_used_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            closed_at INTEGER,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (agent_device_id) REFERENCES agent_devices(id) ON DELETE CASCADE
        )`);
        await runAsync(db, `CREATE TABLE IF NOT EXISTS agent_tool_runs (
            id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            agent_session_id TEXT NOT NULL,
            agent_device_id TEXT NOT NULL,
            conversation_id TEXT,
            request_id TEXT NOT NULL,
            tool_call_id TEXT NOT NULL,
            sequence INTEGER NOT NULL,
            tool_name TEXT NOT NULL,
            input_summary TEXT NOT NULL,
            status TEXT NOT NULL,
            output_preview TEXT,
            output_sha256 TEXT,
            exit_code INTEGER,
            output_truncated INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            completed_at INTEGER,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (agent_session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE,
            UNIQUE(agent_session_id, tool_call_id)
        )`);
        await runAsync(db, 'CREATE INDEX IF NOT EXISTS idx_agent_devices_user_active ON agent_devices(user_id, revoked_at, last_seen_at DESC)');
        await runAsync(db, 'CREATE INDEX IF NOT EXISTS idx_agent_sessions_user_status ON agent_sessions(user_id, status, last_used_at DESC)');
        await runAsync(db, 'CREATE INDEX IF NOT EXISTS idx_agent_tool_runs_conversation ON agent_tool_runs(user_id, conversation_id, created_at DESC)');
        await runAsync(db, 'DELETE FROM agent_pairing_challenges WHERE expires_at < ?', [nowSeconds(now) - 86400]);
        return true;
    }

    function publicStatus() {
        const validIssuer = /^https:\/\/[^\s]+$/i.test(String(issuer || ''));
        return {
            enabled: !!signer && validIssuer,
            protocolVersion: PROTOCOL_VERSION,
            browsers: ['chrome', 'edge'],
            platforms: ['macos', 'linux', 'windows']
        };
    }

    function publicKeys() {
        if (!signer) return [];
        return [{ keyId: signer.keyId, algorithm: 'Ed25519', publicKeyPem: signer.publicKeyPem }];
    }

    function requireEnabled() {
        if (!publicStatus().enabled) throw protocolError('local_agent_unavailable', 503);
    }

    async function startPairing(userId, input = {}) {
        requireEnabled();
        const parsedKey = parsePublicKey(input.publicKey);
        const platform = normalizePlatform(input.platform);
        const capabilities = normalizeCapabilities(input.capabilities);
        if (Number(input.protocolVersion) !== PROTOCOL_VERSION) throw protocolError('unsupported_protocol_version', 409);
        const pairingId = randomId('pair');
        const challenge = crypto.randomBytes(32).toString('base64url');
        const createdAt = nowSeconds(now);
        const device = {
            name: normalizeText(input.name, 100, 'RAI Agent'),
            platform,
            agentVersion: normalizeText(input.agentVersion, 40, '0.0.0'),
            protocolVersion: PROTOCOL_VERSION,
            capabilities
        };
        await runAsync(db, `INSERT INTO agent_pairing_challenges
            (id, user_id, public_key, key_fingerprint, device_json, challenge_hash, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
            pairingId, userId, parsedKey.encoded, parsedKey.fingerprint, JSON.stringify(device),
            hashChallenge(challenge), createdAt, createdAt + PAIRING_TTL_SECONDS
        ]);
        return { pairingId, challenge, expiresAt: createdAt + PAIRING_TTL_SECONDS, confirmationCode: challenge.slice(-6).toUpperCase() };
    }

    async function completePairing(userId, pairingId, input = {}) {
        requireEnabled();
        if (!PAIRING_ID_PATTERN.test(String(pairingId || ''))) throw protocolError('invalid_pairing_id');
        const row = await getAsync(db, 'SELECT * FROM agent_pairing_challenges WHERE id = ? AND user_id = ?', [pairingId, userId]);
        const current = nowSeconds(now);
        if (!row || row.consumed_at) throw protocolError('pairing_not_found', 404);
        if (Number(row.expires_at) < current) throw protocolError('pairing_expired', 410);
        const challenge = String(input.challenge || '');
        if (hashChallenge(challenge) !== row.challenge_hash) throw protocolError('pairing_challenge_mismatch', 409);
        if (!verifySignature(row.public_key, challenge, input.signature)) throw protocolError('pairing_signature_invalid', 403);
        const device = JSON.parse(row.device_json);
        const existing = await getAsync(db, 'SELECT id FROM agent_devices WHERE user_id = ? AND key_fingerprint = ?', [userId, row.key_fingerprint]);
        const deviceId = existing?.id || randomId('agent');
        if (existing) {
            await runAsync(db, `UPDATE agent_devices SET public_key = ?, name = ?, platform = ?, agent_version = ?,
                protocol_version = ?, capabilities_json = ?, last_seen_at = ?, revoked_at = NULL WHERE id = ? AND user_id = ?`, [
                row.public_key, device.name, device.platform, device.agentVersion, PROTOCOL_VERSION,
                JSON.stringify(device.capabilities), current, deviceId, userId
            ]);
        } else {
            await runAsync(db, `INSERT INTO agent_devices
                (id, user_id, public_key, key_fingerprint, name, platform, agent_version, protocol_version,
                 capabilities_json, created_at, last_seen_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
                deviceId, userId, row.public_key, row.key_fingerprint, device.name, device.platform,
                device.agentVersion, PROTOCOL_VERSION, JSON.stringify(device.capabilities), current, current
            ]);
        }
        await runAsync(db, 'UPDATE agent_pairing_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL', [current, pairingId]);
        return {
            deviceId,
            issuer: String(issuer || ''),
            keyId: signer.keyId,
            serverPublicKeyPem: signer.publicKeyPem
        };
    }

    async function listDevices(userId) {
        const rows = await allAsync(db, 'SELECT * FROM agent_devices WHERE user_id = ? ORDER BY revoked_at IS NOT NULL, last_seen_at DESC', [userId]);
        return rows.map(rowToDevice);
    }

    async function revokeDevice(userId, deviceId) {
        if (!DEVICE_ID_PATTERN.test(String(deviceId || ''))) throw protocolError('invalid_device_id');
        const current = nowSeconds(now);
        const result = await runAsync(db, 'UPDATE agent_devices SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL', [current, deviceId, userId]);
        await runAsync(db, `UPDATE agent_sessions SET status = 'closed', closed_at = ?
            WHERE user_id = ? AND agent_device_id = ? AND status != 'closed'`, [current, userId, deviceId]);
        if (!result.changes) throw protocolError('agent_device_not_found', 404);
        return true;
    }

    async function startSession(userId, input = {}) {
        requireEnabled();
        const deviceId = String(input.deviceId || '');
        if (!DEVICE_ID_PATTERN.test(deviceId)) throw protocolError('invalid_device_id');
        const device = await getAsync(db, 'SELECT * FROM agent_devices WHERE id = ? AND user_id = ? AND revoked_at IS NULL', [deviceId, userId]);
        if (!device) throw protocolError('agent_device_not_found', 404);
        const conversationId = normalizeText(input.conversationId, 160) || null;
        const sessionId = randomId('las');
        const challenge = crypto.randomBytes(32).toString('base64url');
        const current = nowSeconds(now);
        await runAsync(db, `INSERT INTO agent_sessions
            (id, user_id, agent_device_id, conversation_id, challenge_hash, status, created_at, last_used_at, expires_at)
            VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`, [
            sessionId, userId, deviceId, conversationId, hashChallenge(challenge), current, current,
            current + SESSION_ABSOLUTE_SECONDS
        ]);
        return { sessionId, challenge, expiresAt: current + PAIRING_TTL_SECONDS, deviceId, conversationId };
    }

    async function acceptSession(userId, sessionId, input = {}) {
        if (!SESSION_ID_PATTERN.test(String(sessionId || ''))) throw protocolError('invalid_agent_session_id');
        const row = await getAsync(db, `SELECT s.*, d.public_key, d.revoked_at FROM agent_sessions s
            JOIN agent_devices d ON d.id = s.agent_device_id
            WHERE s.id = ? AND s.user_id = ?`, [sessionId, userId]);
        const current = nowSeconds(now);
        if (!row || row.revoked_at != null) throw protocolError('agent_session_not_found', 404);
        if (row.status !== 'pending') throw protocolError('agent_session_already_used', 409);
        if (current - Number(row.created_at) > PAIRING_TTL_SECONDS) throw protocolError('agent_session_challenge_expired', 410);
        const challenge = String(input.challenge || '');
        if (hashChallenge(challenge) !== row.challenge_hash) throw protocolError('agent_session_challenge_mismatch', 409);
        if (!verifySignature(row.public_key, challenge, input.signature)) throw protocolError('agent_session_signature_invalid', 403);
        await runAsync(db, `UPDATE agent_sessions SET status = 'active', accepted_at = ?, last_used_at = ?
            WHERE id = ? AND user_id = ? AND status = 'pending'`, [current, current, sessionId, userId]);
        return { sessionId, active: true, expiresAt: Number(row.expires_at) };
    }

    async function closeSession(userId, sessionId) {
        if (!SESSION_ID_PATTERN.test(String(sessionId || ''))) throw protocolError('invalid_agent_session_id');
        const current = nowSeconds(now);
        const result = await runAsync(db, `UPDATE agent_sessions SET status = 'closed', closed_at = ?
            WHERE id = ? AND user_id = ? AND status != 'closed'`, [current, sessionId, userId]);
        return result.changes > 0;
    }

    async function authorizeSession(userId, sessionId, conversationId = '') {
        if (!SESSION_ID_PATTERN.test(String(sessionId || ''))) throw protocolError('invalid_agent_session_id');
        const row = await getAsync(db, `SELECT s.*, d.public_key, d.platform, d.capabilities_json, d.revoked_at
            FROM agent_sessions s JOIN agent_devices d ON d.id = s.agent_device_id
            WHERE s.id = ? AND s.user_id = ?`, [sessionId, userId]);
        const current = nowSeconds(now);
        if (!row || row.status !== 'active' || row.revoked_at != null) throw protocolError('agent_session_inactive', 403);
        if (Number(row.expires_at) < current || current - Number(row.last_used_at) > SESSION_IDLE_SECONDS) {
            await closeSession(userId, sessionId);
            throw protocolError('agent_session_expired', 410);
        }
        const requestedConversation = normalizeText(conversationId, 160);
        if (row.conversation_id && requestedConversation && row.conversation_id !== requestedConversation) {
            throw protocolError('agent_session_conversation_mismatch', 409);
        }
        if (!row.conversation_id && requestedConversation) {
            await runAsync(db, 'UPDATE agent_sessions SET conversation_id = ? WHERE id = ? AND conversation_id IS NULL', [requestedConversation, sessionId]);
            row.conversation_id = requestedConversation;
        }
        await runAsync(db, 'UPDATE agent_sessions SET last_used_at = ? WHERE id = ?', [current, sessionId]);
        return {
            id: row.id,
            deviceId: row.agent_device_id,
            conversationId: row.conversation_id || requestedConversation || null,
            publicKey: row.public_key,
            platform: row.platform,
            capabilities: JSON.parse(row.capabilities_json || '[]')
        };
    }

    async function resolveChatSession(userId, input, conversationId = '') {
        if (input === null || input === undefined) return null;
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
            throw protocolError('invalid_local_agent_request');
        }
        if (Number(input.protocolVersion) !== PROTOCOL_VERSION) {
            throw protocolError('unsupported_local_agent_protocol', 409);
        }
        return authorizeSession(userId, String(input.sessionId || ''), conversationId);
    }

    async function createToolEnvelope({ userId, agentSessionId, conversationId, requestId, toolCallId, sequence, tool, parameters }) {
        requireEnabled();
        const session = await authorizeSession(userId, agentSessionId, conversationId);
        if (!TOOL_CALL_ID_PATTERN.test(String(toolCallId || ''))) throw protocolError('invalid_tool_call_id');
        const runId = randomId('lar');
        const current = nowSeconds(now);
        const envelope = {
            schema: 'rai-local-agent-tool/v1',
            protocolVersion: PROTOCOL_VERSION,
            runId,
            agentSessionId,
            deviceId: session.deviceId,
            conversationId: session.conversationId,
            requestId: normalizeText(requestId, 160),
            toolCallId: String(toolCallId),
            sequence: Math.max(1, Number(sequence || 1)),
            tool: normalizeText(tool, 80),
            parameters: parameters && typeof parameters === 'object' ? parameters : {},
            issuedAt: current,
            expiresAt: current + 5 * 60,
            issuer: String(issuer || ''),
            keyId: signer.keyId
        };
        envelope.signature = crypto.sign(null, Buffer.from(canonicalJson(envelope), 'utf8'), signer.privateKey).toString('base64');
        await runAsync(db, `INSERT INTO agent_tool_runs
            (id, user_id, agent_session_id, agent_device_id, conversation_id, request_id, tool_call_id,
             sequence, tool_name, input_summary, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`, [
            runId, userId, agentSessionId, session.deviceId, session.conversationId,
            envelope.requestId, envelope.toolCallId, envelope.sequence, envelope.tool,
            truncateUtf8(redactSecrets(JSON.stringify(envelope.parameters)), 4096).text, current
        ]);
        return envelope;
    }

    async function validateToolResult(userId, input = {}) {
        const runId = String(input.runId || '');
        if (!RUN_ID_PATTERN.test(runId)) throw protocolError('invalid_agent_run_id');
        const row = await getAsync(db, `SELECT r.*, d.public_key, d.revoked_at FROM agent_tool_runs r
            JOIN agent_devices d ON d.id = r.agent_device_id
            WHERE r.id = ? AND r.user_id = ?`, [runId, userId]);
        if (!row || row.revoked_at != null) throw protocolError('agent_run_not_found', 404);
        if (row.status !== 'pending') {
            if (row.status === 'complete' || row.status === 'failed') return { idempotent: true, result: null, row };
            throw protocolError('agent_run_not_pending', 409);
        }
        const receipt = input.receipt && typeof input.receipt === 'object' ? { ...input.receipt } : {};
        const signature = String(receipt.signature || '');
        delete receipt.signature;
        if (
            receipt.schema !== 'rai-local-agent-result/v1'
            || receipt.runId !== runId
            || receipt.agentSessionId !== row.agent_session_id
            || receipt.deviceId !== row.agent_device_id
            || receipt.toolCallId !== row.tool_call_id
            || Number(receipt.sequence) !== Number(row.sequence)
        ) throw protocolError('agent_result_contract_mismatch', 409);
        const resultHash = crypto.createHash('sha256').update(canonicalJson(input.result || {}), 'utf8').digest('hex');
        if (!/^[a-f0-9]{64}$/.test(String(receipt.resultSha256 || '')) || receipt.resultSha256 !== resultHash) {
            throw protocolError('agent_result_hash_mismatch', 409);
        }
        if (!verifySignature(row.public_key, canonicalJson(receipt), signature)) throw protocolError('agent_result_signature_invalid', 403);
        const normalized = normalizeToolResult(input.result || {});
        const cloudPreview = truncateUtf8(normalized.output, CLOUD_OUTPUT_BYTES);
        const status = normalized.success ? 'complete' : 'failed';
        return {
            idempotent: false,
            result: normalized,
            row,
            completion: {
                status,
                outputPreview: cloudPreview.text,
                outputSha256: normalized.output_sha256,
                exitCode: normalized.exit_code,
                outputTruncated: normalized.truncated || cloudPreview.truncated
            }
        };
    }

    async function finalizeToolResult(userId, candidate = {}) {
        if (candidate.idempotent) return candidate;
        const row = candidate.row || {};
        const completion = candidate.completion || {};
        const runId = String(row.id || '');
        if (!RUN_ID_PATTERN.test(runId) || Number(row.user_id) !== Number(userId)) {
            throw protocolError('agent_result_candidate_invalid', 409);
        }
        const current = nowSeconds(now);
        const result = await runAsync(db, `UPDATE agent_tool_runs SET status = ?, output_preview = ?, output_sha256 = ?,
            exit_code = ?, output_truncated = ?, completed_at = ? WHERE id = ? AND status = 'pending'`, [
            completion.status, completion.outputPreview, completion.outputSha256, completion.exitCode,
            completion.outputTruncated ? 1 : 0, current, runId
        ]);
        if (!result.changes) return { idempotent: true, result: null, row };
        return {
            idempotent: false,
            result: candidate.result,
            row: { ...row, status: completion.status, completed_at: current }
        };
    }

    async function listConversationRuns(userId, conversationId, limit = 20) {
        const normalizedId = normalizeText(conversationId, 160);
        if (!normalizedId) throw protocolError('conversation_id_required');
        const rows = await allAsync(db, `SELECT id, agent_device_id, request_id, tool_call_id, sequence, tool_name,
            input_summary, status, output_preview, output_sha256, exit_code, output_truncated, created_at, completed_at
            FROM agent_tool_runs WHERE user_id = ? AND conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`, [
            userId, normalizedId, Math.max(1, Math.min(Number(limit) || 20, 100))
        ]);
        return rows.reverse().map((row) => ({
            id: row.id,
            deviceId: row.agent_device_id,
            requestId: row.request_id,
            toolCallId: row.tool_call_id,
            sequence: Number(row.sequence),
            tool: row.tool_name,
            inputSummary: row.input_summary,
            status: row.status,
            outputPreview: row.output_preview || '',
            outputSha256: row.output_sha256 || '',
            exitCode: row.exit_code == null ? null : Number(row.exit_code),
            truncated: !!row.output_truncated,
            createdAt: Number(row.created_at),
            completedAt: row.completed_at == null ? null : Number(row.completed_at)
        }));
    }

    return Object.freeze({
        acceptSession,
        authorizeSession,
        closeSession,
        completePairing,
        createToolEnvelope,
        finalizeToolResult,
        listConversationRuns,
        listDevices,
        migrate,
        publicKeys,
        publicIssuer: () => String(issuer || ''),
        publicStatus,
        resolveChatSession,
        revokeDevice,
        startPairing,
        startSession,
        validateToolResult
    });
}

module.exports = Object.freeze({
    CLOUD_OUTPUT_BYTES,
    MODEL_OUTPUT_BYTES,
    PROTOCOL_VERSION,
    createLocalAgentService,
    normalizeToolResult,
    redactSecrets,
    truncateUtf8,
    verifySignature
});
