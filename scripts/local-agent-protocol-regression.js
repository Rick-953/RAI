'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { canonicalJson } = require('../lib/conversation-integrity');
const {
    CLOUD_OUTPUT_BYTES,
    PROTOCOL_VERSION,
    createLocalAgentService,
    truncateUtf8
} = require('../lib/local-agent-protocol');

function runAsync(db, sql, params = []) {
    return new Promise((resolve, reject) => db.run(sql, params, (error) => error ? reject(error) : resolve()));
}

function closeAsync(db) {
    return new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));
}

function getAsync(db, sql, params = []) {
    return new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));
}

function sign(privateKey, value) {
    return crypto.sign(null, Buffer.from(String(value), 'utf8'), privateKey).toString('base64');
}

async function main() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rai-local-agent-test-'));
    const signerPath = path.join(tempDir, 'server.pem');
    const serverKeys = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(signerPath, serverKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    const deviceKeys = crypto.generateKeyPairSync('ed25519');
    const devicePublicKey = deviceKeys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const db = new sqlite3.Database(':memory:');
    await runAsync(db, 'PRAGMA foreign_keys=ON');
    await runAsync(db, 'CREATE TABLE users (id INTEGER PRIMARY KEY)');
    await runAsync(db, 'INSERT INTO users (id) VALUES (1), (2)');

    let clock = Date.parse('2026-08-14T00:00:00Z');
    const service = createLocalAgentService({
        db,
        signingKeyPath: signerPath,
        issuer: 'https://rai.example.test',
        now: () => clock
    });
    await service.migrate();
    assert.equal(service.publicStatus().enabled, true);
    assert.equal(service.publicStatus().protocolVersion, PROTOCOL_VERSION);
    assert.equal(service.publicKeys().length, 1);

    const pairing = await service.startPairing(1, {
        publicKey: devicePublicKey,
        name: 'Rick Mac',
        platform: 'macos',
        agentVersion: '0.1.0',
        protocolVersion: 1,
        capabilities: ['filesystem', 'process', 'browser', 'unknown']
    });
    await assert.rejects(
        service.completePairing(2, pairing.pairingId, { challenge: pairing.challenge, signature: sign(deviceKeys.privateKey, pairing.challenge) }),
        (error) => error.code === 'pairing_not_found'
    );
    const paired = await service.completePairing(1, pairing.pairingId, {
        challenge: pairing.challenge,
        signature: sign(deviceKeys.privateKey, pairing.challenge)
    });
    assert.match(paired.deviceId, /^agent_/);
    assert.equal((await service.listDevices(1))[0].name, 'Rick Mac');

    const pending = await service.startSession(1, { deviceId: paired.deviceId, conversationId: 'session_1' });
    await service.acceptSession(1, pending.sessionId, {
        challenge: pending.challenge,
        signature: sign(deviceKeys.privateKey, pending.challenge)
    });
    const authorized = await service.authorizeSession(1, pending.sessionId, 'session_1');
    assert.equal(authorized.deviceId, paired.deviceId);
    assert.equal(await service.resolveChatSession(1, null, 'session_1'), null);
    assert.equal(
        (await service.resolveChatSession(1, { protocolVersion: 1, sessionId: pending.sessionId }, 'session_1')).deviceId,
        paired.deviceId
    );
    await assert.rejects(
        service.resolveChatSession(1, { protocolVersion: 2, sessionId: pending.sessionId }, 'session_1'),
        (error) => error.code === 'unsupported_local_agent_protocol'
    );
    await assert.rejects(
        service.resolveChatSession(1, 'invalid', 'session_1'),
        (error) => error.code === 'invalid_local_agent_request'
    );
    await assert.rejects(
        service.authorizeSession(1, pending.sessionId, 'session_2'),
        (error) => error.code === 'agent_session_conversation_mismatch'
    );

    const envelope = await service.createToolEnvelope({
        userId: 1,
        agentSessionId: pending.sessionId,
        conversationId: 'session_1',
        requestId: 'req_test',
        toolCallId: 'call_test',
        sequence: 1,
        tool: 'process.exec',
        parameters: { program: 'git', args: ['status'], token: 'secret-value' }
    });
    assert.match(envelope.runId, /^lar_/);
    assert.ok(envelope.signature);

    const rawResult = { success: true, stdout: `token=super-secret\n${'x'.repeat(CLOUD_OUTPUT_BYTES + 4096)}`, exit_code: 0, full_output_available: true };
    const receipt = {
        schema: 'rai-local-agent-result/v1',
        runId: envelope.runId,
        agentSessionId: pending.sessionId,
        deviceId: paired.deviceId,
        toolCallId: 'call_test',
        sequence: 1,
        completedAt: Math.floor(clock / 1000),
        resultSha256: crypto.createHash('sha256').update(canonicalJson(rawResult)).digest('hex')
    };
    receipt.signature = sign(deviceKeys.privateKey, canonicalJson(receipt));
    await assert.rejects(
        service.validateToolResult(1, { runId: envelope.runId, receipt, result: { ...rawResult, stdout: 'tampered' } }),
        (error) => error.code === 'agent_result_hash_mismatch'
    );
    const candidate = await service.validateToolResult(1, {
        runId: envelope.runId,
        receipt,
        result: rawResult
    });
    assert.equal((await getAsync(db, 'SELECT status FROM agent_tool_runs WHERE id = ?', [envelope.runId])).status, 'pending');
    const accepted = await service.finalizeToolResult(1, candidate);
    assert.equal(accepted.result.success, true);
    assert.equal(accepted.result.exit_code, 0);
    assert.ok(!accepted.result.output.includes('super-secret'));
    const replay = await service.validateToolResult(1, { runId: envelope.runId, receipt, result: { success: true } });
    assert.equal(replay.idempotent, true);

    const runs = await service.listConversationRuns(1, 'session_1');
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'complete');
    assert.equal(runs[0].truncated, true);
    assert.ok(Buffer.byteLength(runs[0].outputPreview, 'utf8') <= CLOUD_OUTPUT_BYTES);
    assert.equal(truncateUtf8('short', 100).truncated, false);

    await service.revokeDevice(1, paired.deviceId);
    await assert.rejects(
        service.authorizeSession(1, pending.sessionId, 'session_1'),
        (error) => error.code === 'agent_session_inactive'
    );

    clock += 10 * 60 * 1000;
    const expiredPairing = await service.startPairing(1, {
        publicKey: devicePublicKey,
        name: 'Expired',
        platform: 'macos',
        agentVersion: '0.1.0',
        protocolVersion: 1,
        capabilities: []
    });
    clock += 6 * 60 * 1000;
    await assert.rejects(
        service.completePairing(1, expiredPairing.pairingId, {
            challenge: expiredPairing.challenge,
            signature: sign(deviceKeys.privateKey, expiredPairing.challenge)
        }),
        (error) => error.code === 'pairing_expired'
    );

    await closeAsync(db);
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log('local-agent protocol regression: ok');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
