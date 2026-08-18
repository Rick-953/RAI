#!/usr/bin/env node

'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
    BLOCKED_GITHUB_REPOSITORIES,
    DENYLIST_FEEDS,
    checkFetchDenylist,
    getFetchDenylistStats,
    parseFeedHostnames,
    repositoryFromUrl
} = require('../lib/fetch-denylist');

assert.ok(BLOCKED_GITHUB_REPOSITORIES.size >= 12);
for (const [url, reason] of [
    ['https://github.com/ytisf/theZoo', 'live malware'],
    ['https://raw.githubusercontent.com/kgretzky/evilginx2/master/README.md', 'phishing'],
    ['https://codeload.github.com/htr-tech/zphisher/zip/refs/heads/master', 'phishing'],
    ['https://github.com/screetsec/TheFatRat/archive/refs/heads/master.zip', 'backdoor'],
    ['https://github.com/NYAN-x-CAT/Lime-RAT', 'RAT'],
    ['https://github.com/BloodOnTop/Stealerium', 'stealer']
]) {
    const result = checkFetchDenylist(url);
    assert.equal(result.blocked, true, `${url} should be denied`);
    assert.equal(result.type, 'github_repository');
    assert.ok(result.reason.toLowerCase().includes(reason.toLowerCase()) || result.value);
}
for (const url of [
    'https://github.com/Rick-953/RAI/blob/main/README.md',
    'https://raw.githubusercontent.com/Rick-953/RAI/main/README.md',
    'https://codeload.github.com/Rick-953/RAI/zip/refs/heads/main',
    'https://github.com/Phishing-Database/Phishing.Database/blob/master/README.md',
    'https://github.com/hagezi/dns-blocklists/blob/main/README.md'
]) {
    assert.equal(checkFetchDenylist(url).blocked, false, `${url} should remain allowed`);
}
assert.equal(repositoryFromUrl('https://github.com/ytisf/theZoo/blob/master/README.md'), 'ytisf/thezoo');
assert.equal(repositoryFromUrl('https://raw.githubusercontent.com/ytisf/theZoo/master/README.md'), 'ytisf/thezoo');
assert.equal(repositoryFromUrl('https://codeload.github.com/ytisf/theZoo/zip/refs/heads/master'), 'ytisf/thezoo');
assert.equal(repositoryFromUrl('https://example.com/ytisf/theZoo'), '');

const feedText = `# comment\n0.0.0.0 phishing.example\n127.0.0.1 malware.example\nhttps://bad.example/payload\nnot a valid line\n`;
assert.deepEqual([...parseFeedHostnames(feedText)].sort(), ['bad.example', 'malware.example', 'phishing.example']);
assert.equal(DENYLIST_FEEDS.length >= 2, true);
assert.equal(getFetchDenylistStats().staticRepositories, BLOCKED_GITHUB_REPOSITORIES.size);

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
assert.match(server, /checkFetchDenylist\(urlText\)/);
assert.match(server, /refreshFetchDenylist\(\)/);
assert.match(server, /fetch_url_denylist_blocked/);
assert.match(server, /isHostnameAllowedBySet/);

console.log('fetch denylist regression passed');