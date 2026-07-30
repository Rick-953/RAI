'use strict';

const dns = require('dns').promises;
const http = require('http');
const https = require('https');
const net = require('net');
const ipaddr = require('ipaddr.js');

function policyError(code, details = {}) {
    const error = new Error(code);
    error.code = code;
    Object.assign(error, details);
    return error;
}

function normalizeHostname(hostname = '') {
    return String(hostname || '')
        .trim()
        .toLowerCase()
        .replace(/^\[|\]$/g, '')
        .replace(/\.$/, '');
}

function canonicalIp(address = '') {
    const normalized = normalizeHostname(address);
    try {
        return ipaddr.process(normalized).toString();
    } catch (_) {
        return '';
    }
}

function isPrivateOrReservedIp(address = '') {
    const normalized = normalizeHostname(address);
    let parsed;
    try {
        parsed = ipaddr.process(normalized);
    } catch (_) {
        return true;
    }
    return parsed.range() !== 'unicast';
}

function isHostnameAllowedBySet(hostname = '', allowedHosts = null) {
    if (!allowedHosts || allowedHosts.size === 0) return true;
    const host = normalizeHostname(hostname);
    if (!host) return false;
    for (const allowed of allowedHosts) {
        const normalizedAllowed = normalizeHostname(allowed);
        if (!normalizedAllowed) continue;
        if (host === normalizedAllowed || host.endsWith(`.${normalizedAllowed}`)) return true;
    }
    return false;
}

async function resolveSafeHttpTarget(rawUrl, options = {}) {
    let url;
    try {
        url = rawUrl instanceof URL ? new URL(rawUrl.href) : new URL(String(rawUrl || '').trim());
    } catch (_) {
        throw policyError('image_url_invalid');
    }
    if (!['http:', 'https:'].includes(url.protocol)) throw policyError('image_url_protocol_blocked');
    if (url.username || url.password) throw policyError('image_url_credentials_blocked');

    const hostname = normalizeHostname(url.hostname);
    if (!hostname) throw policyError('image_url_missing_host');
    if (!isHostnameAllowedBySet(hostname, options.allowedHosts || null)) {
        throw policyError('image_url_host_not_allowed');
    }

    let records;
    const ipVersion = net.isIP(hostname);
    if (ipVersion) {
        records = [{ address: hostname, family: ipVersion }];
    } else {
        const resolver = typeof options.lookup === 'function' ? options.lookup : dns.lookup.bind(dns);
        records = await resolver(hostname, { all: true, verbatim: true });
    }
    if (!Array.isArray(records) || records.length === 0) throw policyError('image_url_dns_empty');

    const addresses = [];
    const seen = new Set();
    for (const record of records) {
        const address = canonicalIp(record?.address);
        if (!address) throw policyError('image_url_dns_invalid');
        if (isPrivateOrReservedIp(address)) {
            throw policyError('image_url_private_address_blocked', { address });
        }
        const family = net.isIP(address);
        if (!family) throw policyError('image_url_dns_invalid');
        const key = `${family}:${address}`;
        if (!seen.has(key)) {
            seen.add(key);
            addresses.push({ address, family });
        }
    }
    addresses.sort((left, right) => left.family - right.family);
    return { url, hostname, addresses };
}

function collectPinnedResponse(response, maxBytes) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        const contentLength = Number(response.headers['content-length'] || 0);
        if (Number.isFinite(contentLength) && contentLength > maxBytes) {
            response.destroy();
            reject(policyError('image_response_size_limit'));
            return;
        }
        response.on('data', (chunk) => {
            total += chunk.length;
            if (total > maxBytes) {
                response.destroy(policyError('image_response_size_limit'));
                return;
            }
            chunks.push(chunk);
        });
        response.once('error', reject);
        response.once('end', () => resolve(Buffer.concat(chunks, total)));
    });
}

function requestPinnedAddress(target, address, options = {}) {
    return new Promise((resolve, reject) => {
        const method = String(options.method || 'GET').toUpperCase();
        const timeoutMs = Math.max(500, Number(options.timeoutMs || 5000));
        const maxBytes = Math.max(0, Number(options.maxBytes || (method === 'HEAD' ? 64 * 1024 : 1024 * 1024)));
        const requestLibrary = target.url.protocol === 'https:' ? https : http;
        const expectedAddress = canonicalIp(address.address);
        let settled = false;
        const signal = options.signal;
        const abortError = () => {
            const error = new Error('image_request_aborted');
            error.name = 'AbortError';
            error.code = 'image_request_aborted';
            return error;
        };
        if (signal?.aborted) {
            reject(abortError());
            return;
        }

        let request;
        const cleanupAbortListener = () => signal?.removeEventListener?.('abort', onAbort);
        const onAbort = () => request?.destroy(abortError());

        request = requestLibrary.request({
            protocol: target.url.protocol,
            hostname: target.hostname,
            port: target.url.port || undefined,
            path: `${target.url.pathname}${target.url.search}`,
            method,
            headers: options.headers || {},
            servername: net.isIP(target.hostname) ? undefined : target.hostname,
            // Never let the global Agent hand this security-sensitive request a
            // pooled socket that was connected for an earlier DNS result.
            agent: false,
            maxHeaderSize: 16 * 1024,
            lookup(_hostname, lookupOptions, callback) {
                const pinnedAddress = { address: address.address, family: address.family };
                if (lookupOptions?.all === true) {
                    callback(null, [pinnedAddress]);
                    return;
                }
                callback(null, pinnedAddress.address, pinnedAddress.family);
            }
        }, async (response) => {
            try {
                const buffer = await collectPinnedResponse(response, maxBytes);
                if (settled) return;
                settled = true;
                cleanupAbortListener();
                resolve({
                    statusCode: Number(response.statusCode || 0),
                    headers: response.headers,
                    buffer,
                    remoteAddress: expectedAddress
                });
            } catch (error) {
                if (settled) return;
                settled = true;
                cleanupAbortListener();
                reject(error);
            }
        });

        request.once('socket', (socket) => {
            const verifyRemoteAddress = () => {
                const actualAddress = canonicalIp(socket.remoteAddress);
                if (!actualAddress || actualAddress !== expectedAddress || isPrivateOrReservedIp(actualAddress)) {
                    socket.destroy(policyError('image_socket_address_mismatch', { address: actualAddress || 'unknown' }));
                }
            };
            // A custom Agent or test double may deliver an already-connected
            // socket. Waiting only for a future `connect` event would skip the
            // post-connect address check entirely in that case.
            if (socket.connecting === false) verifyRemoteAddress();
            else socket.once('connect', verifyRemoteAddress);
        });
        request.setTimeout(timeoutMs, () => request.destroy(policyError('image_request_timeout')));
        signal?.addEventListener?.('abort', onAbort, { once: true });
        request.once('error', (error) => {
            if (settled) return;
            settled = true;
            cleanupAbortListener();
            reject(error?.code ? error : policyError('image_request_failed'));
        });
        request.end();
    });
}

async function requestPinnedHttp(target, options = {}) {
    if (options.signal?.aborted) {
        const error = new Error('image_request_aborted');
        error.name = 'AbortError';
        error.code = 'image_request_aborted';
        throw error;
    }
    let lastError = null;
    for (const address of target.addresses) {
        try {
            return await requestPinnedAddress(target, address, options);
        } catch (error) {
            if (options.signal?.aborted || error?.name === 'AbortError') throw error;
            lastError = error;
        }
    }
    throw lastError || policyError('image_request_failed');
}

module.exports = {
    canonicalIp,
    isPrivateOrReservedIp,
    isHostnameAllowedBySet,
    normalizeHostname,
    requestPinnedHttp,
    resolveSafeHttpTarget
};
