'use strict';

const net = require('net');
const { requestPinnedHttp, resolveSafeHttpTarget } = require('./network-address-policy');

const DENYLIST_REFRESH_TTL_MS = 15 * 60 * 1000;
const DENYLIST_FEED_TIMEOUT_MS = 8000;
const DENYLIST_FEED_MAX_BYTES = 8 * 1024 * 1024;

// Exact repository identities only. Do not replace this with keyword matching:
// many defensive, educational, and benign projects contain words such as
// "malware", "phishing", or "crypto" in their names.
const BLOCKED_GITHUB_REPOSITORIES = Object.freeze(new Map([
    ['ytisf/thezoo', 'live malware sample repository'],
    ['da2dalus/the-malware-repo', 'malware sample repository'],
    ['zeustrojancode/zeus', 'trojan source repository'],
    ['vxunderground/malwaresourcecode', 'malware source-code repository'],
    ['kgretzky/evilginx2', 'credential-phishing MITM framework'],
    ['htr-tech/zphisher', 'automated phishing kit'],
    ['htr-tech/nexphisher', 'automated phishing kit'],
    ['m4cs/blackeye-python', 'phishing kit'],
    ['err0r-ica/phishbait', 'phishing tool'],
    ['screetsec/thefatrat', 'backdoor and payload generator'],
    ['nyan-x-cat/lime-rat', 'remote-access trojan'],
    ['bloodontop/stealerium', 'stealer, clipper, and keylogger'],
    ['ninagusev47/silent-crypto-miner', 'crypto-miner builder'],
    ['gulfmousevice/crypto-miner-gpu-cpu-hashrate', 'crypto-miner builder']
]));

// Feed sources are threat-intelligence data, not repositories to block. They
// are fetched through the same pinned public-address policy as user URLs.
const DENYLIST_FEEDS = Object.freeze([
    Object.freeze({
        url: 'https://raw.githubusercontent.com/phishdestroy/destroylist/main/rootlist/formats/primary_active/hosts.txt',
        hosts: new Set(['raw.githubusercontent.com'])
    }),
    Object.freeze({
        url: 'https://urlhaus.abuse.ch/downloads/hostfile/',
        hosts: new Set(['urlhaus.abuse.ch'])
    })
]);

let dynamicBlockedHostnames = new Set();
let refreshedAt = 0;
let refreshPromise = null;

function normalizeHostname(hostname = '') {
    return String(hostname || '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
}

function normalizeRepository(value = '') {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/^\/+|\/+$/g, '')
        .replace(/\.git$/, '');
}

function validHostname(value = '') {
    const host = normalizeHostname(value);
    if (!host || host.length > 253 || net.isIP(host)) return '';
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)) return '';
    if (host.includes('..')) return '';
    return host;
}

function repositoryFromUrl(rawUrl) {
    let parsed;
    try { parsed = rawUrl instanceof URL ? rawUrl : new URL(String(rawUrl || '')); } catch (_) { return ''; }
    const host = normalizeHostname(parsed.hostname);
    const parts = parsed.pathname.split('/').filter(Boolean).map((part) => {
        try { return decodeURIComponent(part); } catch (_) { return part; }
    });
    if (parts.length < 2) return '';
    if (host === 'github.com' || host === 'raw.githubusercontent.com' || host === 'codeload.github.com') {
        return normalizeRepository(`${parts[0]}/${parts[1]}`);
    }
    return '';
}

function isBlockedHostname(hostname, blocked = dynamicBlockedHostnames) {
    const host = normalizeHostname(hostname);
    if (!host) return { blocked: false };
    for (const entry of blocked) {
        const candidate = normalizeHostname(entry);
        if (host === candidate || host.endsWith(`.${candidate}`)) {
            return { blocked: true, hostname: candidate };
        }
    }
    return { blocked: false };
}

function checkFetchDenylist(rawUrl) {
    let parsed;
    try { parsed = rawUrl instanceof URL ? rawUrl : new URL(String(rawUrl || '')); } catch (_) {
        return { blocked: false };
    }
    const repository = repositoryFromUrl(parsed);
    if (repository && BLOCKED_GITHUB_REPOSITORIES.has(repository)) {
        return {
            blocked: true,
            type: 'github_repository',
            value: repository,
            reason: BLOCKED_GITHUB_REPOSITORIES.get(repository)
        };
    }
    const hostnameMatch = isBlockedHostname(parsed.hostname);
    if (hostnameMatch.blocked) {
        return {
            blocked: true,
            type: 'hostname',
            value: hostnameMatch.hostname,
            reason: 'threat-intelligence feed match'
        };
    }
    return { blocked: false };
}

function parseFeedHostnames(text = '') {
    const hosts = new Set();
    for (const rawLine of String(text || '').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#') || line.startsWith('!')) continue;
        let candidate = '';
        const fields = line.split(/\s+/);
        if (fields.length >= 2 && (fields[0] === '0.0.0.0' || fields[0] === '127.0.0.1' || fields[0] === '::')) {
            candidate = fields[1];
        } else if (/^https?:\/\//i.test(line)) {
            try { candidate = new URL(line).hostname; } catch (_) { candidate = ''; }
        } else if (/^[a-z0-9.-]+$/i.test(line)) {
            candidate = line;
        }
        const host = validHostname(candidate);
        if (host && host !== 'localhost' && !host.endsWith('.localhost')) hosts.add(host);
        if (hosts.size >= 250000) break;
    }
    return hosts;
}

async function fetchFeed(feed) {
    const target = await resolveSafeHttpTarget(feed.url, { allowedHosts: feed.hosts });
    const response = await requestPinnedHttp(target, {
        timeoutMs: DENYLIST_FEED_TIMEOUT_MS,
        maxBytes: DENYLIST_FEED_MAX_BYTES
    });
    if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`denylist_feed_http_${response.statusCode}`);
    return parseFeedHostnames(response.buffer.toString('utf8'));
}

async function refreshFetchDenylist({ force = false } = {}) {
    const now = Date.now();
    if (!force && refreshedAt > 0 && now - refreshedAt < DENYLIST_REFRESH_TTL_MS) return dynamicBlockedHostnames.size;
    if (refreshPromise) return await refreshPromise;
    refreshPromise = (async () => {
        const results = await Promise.allSettled(DENYLIST_FEEDS.map(fetchFeed));
        const merged = new Set();
        for (const result of results) {
            if (result.status === 'fulfilled') {
                for (const host of result.value) merged.add(host);
            }
        }
        // Fail closed only for data actually retrieved; retain the last good
        // snapshot when an upstream feed is temporarily unavailable.
        if (merged.size > 0) dynamicBlockedHostnames = merged;
        refreshedAt = Date.now();
        return dynamicBlockedHostnames.size;
    })().finally(() => { refreshPromise = null; });
    return await refreshPromise;
}

function getFetchDenylistStats() {
    return {
        staticRepositories: BLOCKED_GITHUB_REPOSITORIES.size,
        dynamicHostnames: dynamicBlockedHostnames.size,
        refreshedAt
    };
}

module.exports = Object.freeze({
    BLOCKED_GITHUB_REPOSITORIES,
    DENYLIST_FEEDS,
    checkFetchDenylist,
    getFetchDenylistStats,
    isBlockedHostname,
    parseFeedHostnames,
    refreshFetchDenylist,
    repositoryFromUrl
});