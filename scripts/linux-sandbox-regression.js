#!/usr/bin/env node

'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
    GLOBAL_CONCURRENCY,
    MAX_CAPTURE_BYTES,
    MAX_INPUT_BYTES,
    MAX_INPUT_FILES,
    MAX_SCRIPT_BYTES,
    MAX_WORK_BYTES,
    MAX_WORK_FILES,
    OWNER_CONCURRENCY,
    WALL_TIMEOUT_MS,
    findImplicitOutputCandidate,
    normalizeOutputPath
} = require('../lib/linux-sandbox');

assert.equal(MAX_SCRIPT_BYTES, 32 * 1024);
assert.equal(MAX_INPUT_FILES, 8);
assert.equal(MAX_INPUT_BYTES, 20 * 1024 * 1024);
assert.equal(MAX_WORK_BYTES, 24 * 1024 * 1024);
assert.equal(MAX_WORK_FILES, 512);
assert.equal(MAX_CAPTURE_BYTES, 64 * 1024);
assert.equal(WALL_TIMEOUT_MS, 20 * 1000);
assert.equal(GLOBAL_CONCURRENCY, 2);
assert.equal(OWNER_CONCURRENCY, 1);

assert.equal(normalizeOutputPath('results/output.zip'), 'results/output.zip');
for (const blocked of ['/etc/passwd', '../secret', 'a/../../secret', 'a//b', '.', 'a/./b']) {
    assert.throws(() => normalizeOutputPath(blocked), /sandbox_output_path_invalid/);
}

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'lib', 'linux-sandbox.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
assert.match(source, /spawn\('\/usr\/bin\/prlimit'/);
assert.match(source, /'--unshare-all'/);
assert.match(source, /'--clearenv'/);
assert.match(source, /'--cap-drop', 'ALL'/);
assert.match(source, /'--as=2147483648'/);
assert.match(source, /'NODE_OPTIONS', '--max-old-space-size=128'/);
assert.match(source, /'--cpu=15'/);
assert.match(source, /'--nproc=96'/);
assert.match(source, /'--nofile=64'/);
assert.match(source, /'--fsize=16777216'/);
assert.match(source, /'--data=268435456'/);
assert.match(source, /'--stack=8388608'/);
assert.match(source, /auditSandboxScript/);
assert.match(source, /sandbox_command_blocked/);
assert.match(source, /inspectTree\(workspaceDir\)/);
assert.match(source, /findImplicitOutputCandidate\(workspaceDir/);
assert.match(source, /auto_output:\s*implicitOutput/);
assert.match(source, /child\.kill\('SIGKILL'\)/);
assert.doesNotMatch(source, /shell\s*:\s*true/);
assert.doesNotMatch(source, /--share-net|--bind\s*['"]\s*\/['"]/);
assert.match(server, /name: 'sandbox_exec'/);
assert.match(server, /additionalProperties: false/);
assert.match(server, /if \(toolName === 'sandbox_exec'\)/);
assert.match(server, /const sourcePath = path\.resolve\(uploadsRoot, row\.filename\)/);
assert.match(server, /path: sourcePath/);
assert.match(server, /download_available: true/);
assert.doesNotMatch(server, /buildArtifactDownloadMarkdown\(result\)/, 'artifact markdown must not be injected into assistant正文');
assert.match(server, /requiresRaiProductSkill/);
assert.match(server, /forced_rai_product_skill_/);

console.log('linux sandbox regression passed');
