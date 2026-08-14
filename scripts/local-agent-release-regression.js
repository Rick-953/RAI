'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ARTIFACTS, buildChannel } = require('./build-local-agent-channel');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rai-agent-release-test-'));
try {
    for (const fileName of Object.values(ARTIFACTS)) fs.writeFileSync(path.join(directory, fileName), fileName);
    const channel = buildChannel({
        directory,
        version: '0.13.0',
        tag: 'v0.13.0',
        chromeId: 'a'.repeat(32),
        edgeId: 'b'.repeat(32)
    });
    assert.equal(channel.schema, 'rai-local-agent-channel/v1');
    assert.equal(Object.keys(channel.artifacts).length, 4);
    for (const artifact of Object.values(channel.artifacts)) {
        assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
        assert.match(artifact.url, /^https:\/\/github\.com\/Rick-953\/RAI\/releases\/download\/v0\.13\.0\//);
    }
    assert.throws(() => buildChannel({ directory, version: 'x', tag: 'x', chromeId: '', edgeId: '' }), /extension id/);
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'browser-extension', 'manifest.json'), 'utf8'));
    assert.equal(manifest.manifest_version, 3);
    assert.ok(manifest.permissions.includes('nativeMessaging'));
    assert.ok(manifest.host_permissions.includes('https://*/*'));
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const validation = server.indexOf('localAgentService.validateToolResult');
    const claim = server.indexOf('claimClientToolPending(claimedRequestId)', validation);
    const finalize = server.indexOf('localAgentService.finalizeToolResult', validation);
    assert.ok(validation > 0 && claim > validation && finalize > claim, 'signed result must validate, match pending, then finalize');
    assert.match(server, /name: 'process_exec'/);
    const background = fs.readFileSync(path.join(__dirname, '..', 'browser-extension', 'background.js'), 'utf8');
    assert.match(background, /controlledTabId/);
    assert.doesNotMatch(background, /executeBrowserAction\([^\n]+sender\.tab/);
    const nativeSource = fs.readFileSync(path.join(__dirname, '..', 'rai-agent', 'src', 'native.rs'), 'utf8');
    assert.match(nativeSource, /MAX_TRANSPORT_RESULT_BYTES/);
    assert.match(nativeSource, /RAI_LOCAL_OUTPUT_TRUNCATED_FOR_TRANSPORT/);
    const installSource = fs.readFileSync(path.join(__dirname, '..', 'rai-agent', 'src', 'install.rs'), 'utf8');
    assert.match(installSource, /MOVEFILE_REPLACE_EXISTING/);
    const localAgentCss = fs.readFileSync(path.join(__dirname, '..', 'public', 'local-agent.css'), 'utf8');
    assert.match(localAgentCss, /margin:\s*0 auto var\(--chat-content-bottom-clearance/);
    assert.match(localAgentCss, /grid-auto-rows:\s*minmax\(56px, max-content\)/);
    assert.match(localAgentCss, /\.local-agent-activity\[hidden\]\s*\{\s*display:\s*none/);
    console.log('local-agent release regression: ok');
} finally {
    fs.rmSync(directory, { recursive: true, force: true });
}
