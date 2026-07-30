'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function assertStartupRejected(trustProxy, expectedCode) {
    const result = spawnSync(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: {
            PATH: process.env.PATH || '',
            NODE_ENV: 'production',
            HOST: '127.0.0.1',
            TRUST_PROXY: trustProxy
        },
        encoding: 'utf8',
        timeout: 15000
    });
    assert.notStrictEqual(result.error?.code, 'ETIMEDOUT', `TRUST_PROXY=${trustProxy} startup probe must complete`);
    assert.notStrictEqual(result.status, 0, `TRUST_PROXY=${trustProxy} must fail closed in production`);
    assert.match(
        `${result.stdout || ''}\n${result.stderr || ''}`,
        new RegExp(expectedCode),
        `TRUST_PROXY=${trustProxy} must fail with ${expectedCode}`
    );
}

function sourceFiles(root) {
    const ignoredDirectories = new Set([
        '.git', 'node_modules', 'historical-releases', 'security-artifacts',
        'uploads', 'avatars', 'database', 'target', 'icons', 'images', 'downloads'
    ]);
    const ignoredFiles = new Set(['短期记忆.txt', '维护详细记录.txt', '更新运维.txt', 'rai运行报告.md']);
    const allowedExtensions = new Set(['.js', '.json', '.md', '.txt', '.yml', '.yaml', '.toml', '.html', '.css', '.rs', '.example']);
    const files = [];
    const visit = (directory) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (entry.isDirectory() && (ignoredDirectories.has(entry.name) || entry.name.startsWith('_'))) continue;
            if (!entry.isDirectory() && ignoredFiles.has(entry.name)) continue;
            const target = path.join(directory, entry.name);
            if (entry.isDirectory()) visit(target);
            else if (allowedExtensions.has(path.extname(entry.name)) || entry.name === '.env.example') files.push(target);
        }
    };
    visit(root);
    return files;
}

assertStartupRejected('1', 'production_trust_proxy_requires_explicit_cidr');
assertStartupRejected('2', 'production_trust_proxy_requires_explicit_cidr');
assertStartupRejected('true', 'production_trust_proxy_requires_explicit_cidr');
assertStartupRejected('127.0.0.1/99', 'invalid_trust_proxy_cidr');
assertStartupRejected('::1/129', 'invalid_trust_proxy_cidr');

const retiredProviderToken = ['NEW', 'API'].join('');
const scannedFiles = sourceFiles(ROOT);
assert.deepStrictEqual(
    scannedFiles
        .map((filename) => path.basename(filename))
        .filter((filename) => ['短期记忆.txt', '维护详细记录.txt', '更新运维.txt', 'rai运行报告.md'].includes(filename)),
    [],
    'historical operations records and runtime reports must stay outside active source/config scans'
);
const references = scannedFiles
    .filter((filename) => filename !== __filename)
    .filter((filename) => fs.readFileSync(filename, 'utf8').toUpperCase().includes(retiredProviderToken));
assert.deepStrictEqual(
    references.map((filename) => path.relative(ROOT, filename)),
    [],
    'retired implicit third-party gateway configuration must have zero source/config references'
);

console.log('security-config-regression ok production_proxy_hops_rejected invalid_cidr_rejected retired_gateway_refs=0');
