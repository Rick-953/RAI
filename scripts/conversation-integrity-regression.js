#!/usr/bin/env node

'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    buildConversationDocument,
    canonicalJson,
    createConversationReceipt,
    loadConversationSigner,
    verifyConversationReceipt,
    writeConversationReceiptLedgers
} = require('../lib/conversation-integrity');
const { findImplicitOutputCandidate } = require('../lib/linux-sandbox');

async function main() {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rai-conversation-integrity-'));
    try {
        const { privateKey } = crypto.generateKeyPairSync('ed25519');
        const keyPath = path.join(root, 'signing.pem');
        await fs.promises.writeFile(
            keyPath,
            privateKey.export({ type: 'pkcs8', format: 'pem' }),
            { mode: 0o600 }
        );
        const signer = loadConversationSigner(keyPath);
        const document = buildConversationDocument({
            issuer: 'https://rai.example/beta',
            session: {
                id: 'session_integrity',
                title: 'Integrity check',
                created_at: '2026-08-06T00:00:00.000Z',
                updated_at: '2026-08-06T00:01:00.000Z'
            },
            messages: [
                { id: 1, role: 'user', content: 'hello', created_at: '2026-08-06T00:00:10.000Z' },
                { id: 2, role: 'assistant', content: 'world', model: 'deepseek-flash', sources: '[]', created_at: '2026-08-06T00:00:11.000Z' }
            ]
        });
        const receipt = createConversationReceipt({
            document,
            messagesRevision: 2,
            signer,
            signedAt: '2026-08-06T00:02:00.000Z'
        });
        assert.match(receipt.digest, /^[a-f0-9]{64}$/);
        assert.equal(verifyConversationReceipt({ document, receipt, trustedKeyId: signer.keyId }).authentic, true);
        assert.equal(verifyConversationReceipt({
            document: { ...document, conversation: { ...document.conversation, title: 'tampered' } },
            receipt,
            trustedKeyId: signer.keyId
        }).reason, 'conversation_digest_mismatch');
        assert.equal(canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}');

        const primaryDir = path.join(root, 'server-ledger');
        const mirrorDir = path.join(root, 'pcloud-mirror');
        await fs.promises.mkdir(mirrorDir, { mode: 0o700 });
        const replicated = await writeConversationReceiptLedgers({ receipt, primaryDir, mirrorDir });
        assert.equal(Boolean(replicated.primary), true);
        assert.equal(Boolean(replicated.mirror), true);
        assert.equal(replicated.mirrorError, null);
        const missingMirror = await writeConversationReceiptLedgers({
            receipt,
            primaryDir,
            mirrorDir: path.join(root, 'not-mounted')
        });
        assert.equal(missingMirror.mirror, null);
        assert.equal(missingMirror.mirrorError, 'conversation_mirror_unavailable');

        const workspace = path.join(root, 'workspace');
        await fs.promises.mkdir(workspace);
        await fs.promises.writeFile(path.join(workspace, 'input.txt'), 'input');
        await fs.promises.writeFile(path.join(workspace, 'summary.docx'), Buffer.from('PK\u0003\u0004fixture'));
        assert.equal(
            await findImplicitOutputCandidate(workspace, new Set(['input.txt'])),
            path.join(workspace, 'summary.docx')
        );
        await fs.promises.writeFile(path.join(workspace, 'second.zip'), Buffer.from('PK\u0003\u0004fixture'));
        assert.equal(await findImplicitOutputCandidate(workspace, new Set(['input.txt'])), null);

        const server = await fs.promises.readFile(path.join(__dirname, '..', 'server.js'), 'utf8');
        const app = await fs.promises.readFile(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
        assert.match(server, /conversation_integrity_receipts/);
        assert.match(server, /\/api\/sessions\/:id\/export/);
        assert.match(server, /\/api\/conversation-integrity\/verify/);
        assert.match(server, /scheduleConversationIntegritySeal\(sessionId, req\.user\.userId\)/);
        assert.ok(
            (server.match(/scheduleConversationIntegritySeal\(sessionId, req\.user\.userId\)/g) || []).length >= 4,
            'all chat completion branches must schedule a conversation receipt'
        );
        assert.match(server, /concurrent_requests_free:\s*FREE_CONCURRENT_REQUESTS_DEFAULT/);
        assert.match(server, /concurrent_requests_pro_max:\s*PRO_MAX_CONCURRENT_REQUESTS_DEFAULT/);
        assert.match(server, /tier === 'pro' \|\| tier === 'max'/);
        assert.match(app, /data-action="export"/);
        assert.match(app, /Free 最大并发/);
        assert.match(app, /Pro \/ MAX 最大并发/);
        console.log('conversation integrity regression passed (signature, tamper rejection, dual ledger, implicit artifact, tiered concurrency contracts)');
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
