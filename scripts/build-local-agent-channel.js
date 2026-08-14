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

function extensionId(value, name) {
    const id = String(value || '').trim();
    if (!/^[a-p]{32}$/.test(id)) throw new Error(`${name} must be a 32 character Chrome extension id`);
    return id;
}

function buildChannel({ directory, version, tag, chromeId, edgeId, repository = 'Rick-953/RAI' }) {
    const artifacts = {};
    for (const [platform, fileName] of Object.entries(ARTIFACTS)) {
        const filePath = path.join(directory, fileName);
        const bytes = fs.readFileSync(filePath);
        artifacts[platform] = {
            url: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${fileName}`,
            sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
            size: bytes.length
        };
    }
    return {
        schema: 'rai-local-agent-channel/v1',
        version,
        repository,
        signerWorkflow: `${repository}/.github/workflows/local-agent-release.yml`,
        extensions: {
            chrome: extensionId(chromeId, 'Chrome extension id'),
            edge: extensionId(edgeId, 'Edge extension id')
        },
        artifacts
    };
}

if (require.main === module) {
    const [directory, version, tag, output] = process.argv.slice(2);
    if (!directory || !version || !tag || !output) {
        throw new Error('usage: build-local-agent-channel <dist> <version> <tag> <output>');
    }
    const channel = buildChannel({
        directory,
        version,
        tag,
        chromeId: process.env.RAI_CHROME_EXTENSION_ID,
        edgeId: process.env.RAI_EDGE_EXTENSION_ID
    });
    fs.writeFileSync(output, `${JSON.stringify(channel, null, 2)}\n`, { flag: 'wx' });
}

module.exports = Object.freeze({ ARTIFACTS, buildChannel });
