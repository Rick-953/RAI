'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ARTIFACTS = Object.freeze({
    'macos-aarch64': 'rai-agent-aarch64-apple-darwin.tar.gz',
    'macos-x86_64': 'rai-agent-x86_64-apple-darwin.tar.gz',
    'linux-x86_64': 'rai-agent-x86_64-unknown-linux-gnu.tar.gz',
    'windows-x86_64': 'rai-agent-x86_64-pc-windows-msvc.zip'
});
const EXTENSION_ASSET = 'rai-connect-extension.zip';

function releaseArtifact(directory, fileName, tag, repository) {
    const bytes = fs.readFileSync(path.join(directory, fileName));
    return {
        url: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${fileName}`,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length
    };
}

function extensionIdFromManifestKey(value) {
    const key = String(value || '').replace(/\s+/g, '');
    const bytes = Buffer.from(key, 'base64');
    if (!key || bytes.length < 128 || bytes.toString('base64') !== key) {
        throw new Error('browser extension manifest key must be canonical base64 public-key data');
    }
    const digest = crypto.createHash('sha256').update(bytes).digest().subarray(0, 16);
    return [...digest]
        .map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 0x0f)))
        .join('');
}

function buildChannel({ directory, version, tag, manifest, repository = 'Rick-953/RAI' }) {
    if (!manifest || manifest.manifest_version !== 3) throw new Error('Manifest V3 extension is required');
    if (String(manifest.version || '') !== String(version || '')) {
        throw new Error('browser extension version must match the release version');
    }
    const extensionId = extensionIdFromManifestKey(manifest.key);
    const artifacts = {};
    for (const [platform, fileName] of Object.entries(ARTIFACTS)) {
        artifacts[platform] = releaseArtifact(directory, fileName, tag, repository);
    }
    return {
        schema: 'rai-local-agent-channel/v1',
        version,
        repository,
        signerWorkflow: `${repository}/.github/workflows/local-agent-release.yml`,
        extensions: {
            distribution: 'github-unpacked',
            id: extensionId,
            chrome: extensionId,
            edge: extensionId,
            artifact: releaseArtifact(directory, EXTENSION_ASSET, tag, repository)
        },
        artifacts
    };
}

if (require.main === module) {
    const [directory, version, tag, output] = process.argv.slice(2);
    if (!directory || !version || !tag || !output) {
        throw new Error('usage: build-local-agent-channel <dist> <version> <tag> <output>');
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'browser-extension', 'manifest.json'), 'utf8'));
    const channel = buildChannel({
        directory,
        version,
        tag,
        manifest
    });
    fs.writeFileSync(output, `${JSON.stringify(channel, null, 2)}\n`, { flag: 'wx' });
}

module.exports = Object.freeze({ ARTIFACTS, EXTENSION_ASSET, buildChannel, extensionIdFromManifestKey });
