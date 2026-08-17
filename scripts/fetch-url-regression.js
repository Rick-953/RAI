#!/usr/bin/env node

'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
    isHostnameAllowedBySet,
    resolveSafeHttpTarget
} = require('../lib/network-address-policy');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const sandboxSkill = fs.readFileSync(path.join(root, 'skills', 'sandbox', 'SKILL.md'), 'utf8');

// Static contract: the fetch_url tool exists end-to-end.
assert.match(server, /const FETCH_URL_TOOL_DEFINITION = \{/);
assert.match(server, /name: 'fetch_url'/);
assert.match(server, /name: 'fetch_url'/);
assert.match(server, /FETCH_URL_DOWNLOAD_MAX_BYTES = 16 \* 1024 \* 1024/);
assert.match(server, /FETCH_URL_TIMEOUT_MS = 15000/);
assert.match(server, /RAI_FETCH_EXTRA_HOSTS/);
assert.match(server, /'github\.com'/);
assert.match(server, /'githubusercontent\.com'/);
assert.match(server, /'gitlab\.com'/);
// Mounted only for server-side file tools (never in client-local toolchains).
assert.match(server, /SANDBOX_EXEC_TOOL_DEFINITION,\n\s+FETCH_URL_TOOL_DEFINITION/);
// Argument normalization rejects non-http(s), credentials and local-mode use.
assert.match(server, /if \(toolName === 'fetch_url'\) \{/);
assert.match(server, /if \(localMode\) return null; \/\/ server-side gate only/);
assert.match(server, /parsed\.username \|\| parsed\.password/);
// Executor enforces the host allowlist before any connection attempt.
assert.match(server, /isHostnameAllowedBySet\(hostname, FETCH_URL_HOST_ALLOWLIST\)/);
// SSRF layer and size limits are applied through the pinned HTTP gate.
assert.match(server, /resolveSafeHttpTarget\(urlText, \{ allowedHosts: FETCH_URL_HOST_ALLOWLIST \}\)/);
assert.match(server, /requestPinnedHttp\(target, \{ timeoutMs: FETCH_URL_TIMEOUT_MS, maxBytes: FETCH_URL_DOWNLOAD_MAX_BYTES \}\)/);
// Content policy mirrors the upload pipeline.
assert.match(server, /BLOCKED_UPLOAD_EXTENSIONS\.has\(ext\)/);
assert.match(server, /looksLikeActiveWebContent\(response\.buffer\)/);
assert.match(server, /fetch_url_content_blocked/);
// The downloaded file lands in the attachment pipeline and returns a file_id.
assert.match(server, /recordUploadedFileWithinQuota\(/);
assert.match(server, /validateUploadedFileContent\(/);
assert.match(server, /sha256/);
assert.match(server, /if \(toolName === 'fetch_url'\) \{/);
// Tool result tells the model to reuse the file_id via workspace tools.
assert.match(server, /Reference it by its file_id/);
// The workspace catalog and sandbox hints advertise the gate.
assert.match(server, /fetch_url 下载/);
assert.match(server, /沙箱进程无网络，外部文件用 fetch_url 下载/);
// README-style skill documents the gate for the model.
assert.match(sandboxSkill, /Downloading files \(fetch_url\)/);
assert.match(sandboxSkill, /no direct network/);

// Host allowlist semantics: exact host or subdomain, everything else refused.
const allowlist = new Set(['github.com', 'githubusercontent.com', 'gitlab.com']);
for (const host of [
    'github.com', 'api.github.com', 'raw.githubusercontent.com',
    'codeload.github.com', 'objects.githubusercontent.com', 'gist.github.com',
    'gitlab.com', 'gitlab.example.gitlab.com'
]) {
    assert.equal(isHostnameAllowedBySet(host, allowlist), true, `allow ${host}`);
}
for (const host of ['evil.example.com', 'example.com', 'localhost', '127.0.0.1', '10.0.0.1', '169.254.169.254']) {
    assert.equal(isHostnameAllowedBySet(host, allowlist), false, `deny ${host}`);
}

// SSRF layer refuses cloud metadata and private ranges without any network I/O
// when the target is a literal IP (direct address path in resolveSafeHttpTarget).
async function expectRejected(urlText) {
    let rejected = false;
    try {
        await resolveSafeHttpTarget(urlText, { allowedHosts: allowlist });
    } catch (error) {
        // Any policy rejection counts: host allowlist, SSRF private/reserved
        // address block, or protocol rejection.
        rejected = Boolean(error?.code);
    }
    assert.equal(rejected, true, `expected SSRF rejection for ${urlText}`);
}

(async () => {
    await expectRejected('http://169.254.169.254/latest/meta-data/');
    await expectRejected('http://127.0.0.1/admin');
    await expectRejected('http://10.10.10.10/x');
    console.log('fetch url regression passed');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});