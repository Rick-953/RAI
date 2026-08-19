'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ARTIFACTS, EXTENSION_ASSET, buildChannel, extensionIdFromManifestKey } = require('./build-local-agent-channel');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rai-agent-release-test-'));
try {
    for (const fileName of Object.values(ARTIFACTS)) fs.writeFileSync(path.join(directory, fileName), fileName);
    fs.writeFileSync(path.join(directory, EXTENSION_ASSET), 'extension archive');
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'browser-extension', 'manifest.json'), 'utf8'));
    const channel = buildChannel({
        directory,
        version: '0.13.16',
        tag: 'v0.13.16',
        manifest
    });
    assert.equal(channel.schema, 'rai-local-agent-channel/v1');
    assert.equal(Object.keys(channel.artifacts).length, 4);
    for (const artifact of Object.values(channel.artifacts)) {
        assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
        assert.match(artifact.url, /^https:\/\/github\.com\/Rick-953\/RAI\/releases\/download\/v0\.13\.16\//);
    }
    assert.equal(channel.extensions.distribution, 'github-unpacked');
    assert.equal(channel.extensions.id, 'clnmniaaodjmcgnemigghniekmahgcgi');
    assert.equal(channel.extensions.chrome, channel.extensions.id);
    assert.equal(channel.extensions.edge, channel.extensions.id);
    assert.match(channel.extensions.artifact.sha256, /^[a-f0-9]{64}$/);
    assert.match(channel.extensions.artifact.url, /\/rai-connect-extension\.zip$/);
    assert.equal(extensionIdFromManifestKey(manifest.key), channel.extensions.id);
    assert.throws(() => buildChannel({ directory, version: '0.13.0', tag: 'x', manifest }), /version must match/);
    assert.throws(() => extensionIdFromManifestKey('not-base64'), /manifest key/);
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.version, '0.13.16');
    assert.ok(manifest.key);
    assert.ok(manifest.permissions.includes('nativeMessaging'));
    assert.ok(manifest.host_permissions.includes('https://*/*'));
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    for (const route of [
        '/api/agent/pairings/start',
        '/api/agent/pairings/:id/complete',
        '/api/agent/devices',
        '/api/agent/devices/:id',
        '/api/agent/sessions',
        '/api/agent/sessions/:id/accept',
        '/api/agent/sessions/:id',
        '/api/agent/tool-runs',
        '/api/agent/tool-results',
        '/api/agent/tool-result'
    ]) {
        const escaped = route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        assert.match(server, new RegExp(`app\\.(?:get|post|delete)\\('${escaped}', apiLimiter, authenticateToken`));
    }
    assert.match(server, /rawClientFileExecution === true && !req\.softwareClient/);
    assert.match(server, /localAgentService\.resolveChatSession/);
    assert.match(server, /formatPrivateLogFingerprint\(requestedSessionId \|\| '', 'sessionId'\)/);
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
    const localReleaseWorkflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'local-agent-release.yml'), 'utf8');
    const securityWorkflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'security.yml'), 'utf8');
    assert.match(localReleaseWorkflow, /dist\/LOCAL_AGENT_SHA256SUMS/);
    assert.doesNotMatch(localReleaseWorkflow, /dist\/SHA256SUMS/);
    assert.match(securityWorkflow, /for attempt in \$\(seq 1 15\)/);
    assert.match(securityWorkflow, /new draft release could not be resolved by tag/);
    const unixInstaller = fs.readFileSync(path.join(__dirname, '..', 'install.sh'), 'utf8');
    const windowsInstaller = fs.readFileSync(path.join(__dirname, '..', 'install.ps1'), 'utf8');
    for (const installer of [unixInstaller, windowsInstaller]) {
        assert.match(installer, /github-unpacked/);
        assert.match(installer, /rai-connect-extension\.zip/);
        assert.doesNotMatch(installer, /open-store=false/);
        assert.match(installer, /extensionTarget|EXTENSION_TARGET/);
    }
    const localAgentCss = fs.readFileSync(path.join(__dirname, '..', 'public', 'local-agent.css'), 'utf8');
    assert.match(localAgentCss, /margin:\s*0 auto var\(--chat-content-bottom-clearance/);
    assert.match(localAgentCss, /grid-auto-rows:\s*minmax\(56px, max-content\)/);
    assert.match(localAgentCss, /\.local-agent-activity\[hidden\]\s*\{\s*display:\s*none/);
    assert.match(localAgentCss, /\.settings-connect-command-list\s*\{[\s\S]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
    assert.match(localAgentCss, /@media \(max-width:\s*600px\)[\s\S]*\.settings-connect-command-list\s*\{\s*grid-template-columns:\s*1fr/);
    assert.match(localAgentCss, /@media \(max-width:\s*600px\)[\s\S]*\.settings-connect-install-header\s*\{[^}]*flex-direction:\s*column/);
    const web = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const capabilitiesStart = web.indexOf('data-settings-panel="capabilities"');
    const securityStart = web.indexOf('data-settings-panel="security"');
    const localAgentCard = web.indexOf('id="settingsLocalAgentCard"');
    assert.ok(capabilitiesStart > 0 && localAgentCard > capabilitiesStart && localAgentCard < securityStart, 'Local Agent settings must be under Capabilities');
    assert.equal((web.match(/id="settingsLocalAgentCard"/g) || []).length, 1);
    assert.match(web, /id="settingsRaiConnectInstall"/);
    assert.match(web, /releases\/latest\/download\/install\.sh/);
    assert.match(web, /releases\/latest\/download\/install\.ps1/);
    assert.match(web, /chrome:\/\/extensions/);
    assert.match(web, /edge:\/\/extensions/);
    assert.match(web, /data-local-agent-copy="unix"/);
    assert.match(web, /data-local-agent-copy="windows"/);
    const webAgent = fs.readFileSync(path.join(__dirname, '..', 'public', 'local-agent.js'), 'utf8');
    assert.doesNotMatch(webAgent, /请先创建或打开一个对话/);
    assert.match(webAgent, /当前是尚未保存的新对话。请先发送第一条消息创建对话/);
    assert.match(webAgent, /等待创建对话/);
    assert.match(webAgent, /function openInstallGuide\(\)/);
    const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    assert.match(app, /SETTINGS_SEARCH_TARGET_SELECTOR[\s\S]*'\.settings-connect-install'/);
    assert.match(app, /SETTINGS_SEARCH_TARGET_SELECTOR[\s\S]*'\.local-agent-settings-card'/);
    const settingsCss = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
    assert.match(settingsCss, /@media \(min-width:\s*861px\)[\s\S]*\.settings-sidebar\s*\{[\s\S]*overflow-y:\s*hidden/);
    assert.match(settingsCss, /@media \(min-width:\s*861px\)[\s\S]*\.settings-nav\s*\{[\s\S]*flex:\s*1 1 auto[\s\S]*overflow-y:\s*auto/);
    console.log('local-agent release regression: ok');
} finally {
    fs.rmSync(directory, { recursive: true, force: true });
}
