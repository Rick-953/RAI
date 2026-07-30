'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const http = require('http');
const { PassThrough } = require('stream');
const {
    canonicalIp,
    isPrivateOrReservedIp,
    isHostnameAllowedBySet,
    requestPinnedHttp,
    resolveSafeHttpTarget
} = require('../lib/network-address-policy');

async function expectPolicyError(action, code) {
    await assert.rejects(
        action,
        (error) => error?.code === code,
        `expected network policy error ${code}`
    );
}

function installHttpRequestMock(handler) {
    const original = http.request;
    http.request = handler;
    return () => {
        http.request = original;
    };
}

function createPinnedRequestMock({ remoteAddress, body = 'ok', statusCode = 200, onOptions, alreadyConnected = false }) {
    return (options, callback) => {
        onOptions?.(options);
        const request = new EventEmitter();
        let ended = false;
        request.setTimeout = () => request;
        request.destroy = (error) => {
            if (error) queueMicrotask(() => request.emit('error', error));
            return request;
        };
        request.end = () => {
            if (ended) return;
            ended = true;
            const socket = new EventEmitter();
            let socketDestroyed = false;
            socket.remoteAddress = remoteAddress;
            socket.connecting = !alreadyConnected;
            socket.destroy = (error) => {
                socketDestroyed = true;
                if (error) queueMicrotask(() => request.emit('error', error));
            };
            queueMicrotask(() => {
                request.emit('socket', socket);
                if (!alreadyConnected) {
                    socket.connecting = false;
                    socket.emit('connect');
                }
                if (socketDestroyed) return;
                const response = new PassThrough();
                response.statusCode = statusCode;
                response.headers = { 'content-length': String(Buffer.byteLength(body)) };
                callback(response);
                response.end(body);
            });
        };
        return request;
    };
}

async function main() {
    const checks = [];

    assert.strictEqual(canonicalIp('::ffff:127.0.0.1'), '127.0.0.1');
    assert.strictEqual(canonicalIp('::ffff:7f00:1'), '127.0.0.1');
    assert.strictEqual(canonicalIp('::ffff:a9fe:a9fe'), '169.254.169.254');
    checks.push('mapped_ipv6_canonicalized');

    for (const address of [
        '127.0.0.1',
        '10.0.0.1',
        '172.16.0.1',
        '192.168.1.1',
        '169.254.169.254',
        '0.0.0.0',
        '192.0.2.1',
        '::1',
        'fc00::1',
        'fd00::1',
        'fe80::1',
        '::ffff:7f00:1',
        '::ffff:a00:1',
        '::ffff:a9fe:a9fe',
        '::ffff:c0a8:101'
    ]) {
        assert.strictEqual(isPrivateOrReservedIp(address), true, `${address} must be blocked`);
    }
    for (const address of ['1.1.1.1', '8.8.8.8', '2001:4860:4860::8888']) {
        assert.strictEqual(isPrivateOrReservedIp(address), false, `${address} must remain usable`);
    }
    assert.strictEqual(isPrivateOrReservedIp('not-an-ip'), true, 'invalid addresses must fail closed');
    checks.push('private_reserved_and_public_ranges');

    const allowedHosts = new Set(['cdn.example.test']);
    assert.strictEqual(isHostnameAllowedBySet('cdn.example.test', allowedHosts), true);
    assert.strictEqual(isHostnameAllowedBySet('assets.cdn.example.test', allowedHosts), true);
    assert.strictEqual(isHostnameAllowedBySet('cdn.example.test.attacker.invalid', allowedHosts), false);
    assert.strictEqual(isHostnameAllowedBySet('evil-cdn.example.test', allowedHosts), false);
    checks.push('hostname_allowlist_boundaries');

    const safeLookupCalls = [];
    const safeTarget = await resolveSafeHttpTarget('https://cdn.example.test/image.png?size=small', {
        allowedHosts,
        lookup: async (hostname, options) => {
            safeLookupCalls.push({ hostname, options });
            return [
                { address: '93.184.216.34', family: 4 },
                { address: '2001:4860:4860::8888', family: 6 },
                { address: '93.184.216.34', family: 4 }
            ];
        }
    });
    assert.strictEqual(safeLookupCalls.length, 1, 'target DNS must resolve exactly once during validation');
    assert.strictEqual(safeLookupCalls[0].hostname, 'cdn.example.test');
    assert.deepStrictEqual(safeTarget.addresses, [
        { address: '93.184.216.34', family: 4 },
        { address: '2001:4860:4860::8888', family: 6 }
    ]);
    checks.push('dns_resolved_once_and_deduplicated');

    await expectPolicyError(
        resolveSafeHttpTarget('https://mixed.example.test/image.png', {
            lookup: async () => [
                { address: '93.184.216.34', family: 4 },
                { address: '::ffff:7f00:1', family: 6 }
            ]
        }),
        'image_url_private_address_blocked'
    );
    await expectPolicyError(resolveSafeHttpTarget('file:///tmp/local'), 'image_url_protocol_blocked');
    await expectPolicyError(resolveSafeHttpTarget('https://user:pass@cdn.example.test/image.png'), 'image_url_credentials_blocked');
    await expectPolicyError(
        resolveSafeHttpTarget('https://cdn.example.test.attacker.invalid/image.png', {
            allowedHosts,
            lookup: async () => [{ address: '93.184.216.34', family: 4 }]
        }),
        'image_url_host_not_allowed'
    );
    checks.push('unsafe_resolution_inputs_blocked');

    const redirectDestination = new URL('http://[::ffff:7f00:1]/metadata', safeTarget.url);
    await expectPolicyError(resolveSafeHttpTarget(redirectDestination), 'image_url_private_address_blocked');
    const safeRedirect = await resolveSafeHttpTarget(new URL('/redirected.png', safeTarget.url), {
        allowedHosts,
        lookup: async () => [{ address: '93.184.216.35', family: 4 }]
    });
    assert.strictEqual(safeRedirect.url.pathname, '/redirected.png');
    assert.deepStrictEqual(safeRedirect.addresses, [{ address: '93.184.216.35', family: 4 }]);
    checks.push('redirect_destinations_revalidated');

    let pinnedLookupResult = null;
    let pinnedLookupAllResult = null;
    let pinnedRequestCount = 0;
    const restorePinnedMock = installHttpRequestMock(createPinnedRequestMock({
        remoteAddress: '93.184.216.34',
        body: 'mock-image',
        onOptions(options) {
            pinnedRequestCount += 1;
            assert.strictEqual(options.hostname, 'cdn.example.test', 'TLS/HTTP hostname must stay on the validated host');
            assert.strictEqual(options.servername, 'cdn.example.test', 'TLS SNI must stay on the validated host');
            assert.strictEqual(options.agent, false, 'security-sensitive requests must never reuse a global Agent socket');
            options.lookup('ignored.example', {}, (error, address, family) => {
                assert.ifError(error);
                pinnedLookupResult = { address, family };
            });
            options.lookup('ignored.example', { all: true }, (error, addresses) => {
                assert.ifError(error);
                pinnedLookupAllResult = addresses;
            });
        }
    }));
    try {
        const result = await requestPinnedHttp({
            url: new URL('http://cdn.example.test/image.png'),
            hostname: 'cdn.example.test',
            addresses: [{ address: '93.184.216.34', family: 4 }]
        }, { timeoutMs: 1000, maxBytes: 1024 });
        assert.strictEqual(result.buffer.toString('utf8'), 'mock-image');
        assert.strictEqual(result.remoteAddress, '93.184.216.34');
    } finally {
        restorePinnedMock();
    }
    assert.strictEqual(pinnedRequestCount, 1);
    assert.deepStrictEqual(pinnedLookupResult, { address: '93.184.216.34', family: 4 });
    assert.deepStrictEqual(
        pinnedLookupAllResult,
        [{ address: '93.184.216.34', family: 4 }],
        'Node 24 all:true lookup calls must receive a pinned address array'
    );
    checks.push('request_uses_validated_pinned_address');

    let abortedRequestCount = 0;
    const restoreAbortMock = installHttpRequestMock(createPinnedRequestMock({
        remoteAddress: '93.184.216.34',
        body: 'must-not-complete',
        onOptions() {
            abortedRequestCount += 1;
        }
    }));
    try {
        const preAborted = new AbortController();
        preAborted.abort();
        await assert.rejects(
            requestPinnedHttp({
                url: new URL('http://cdn.example.test/image.png'),
                hostname: 'cdn.example.test',
                addresses: [
                    { address: '93.184.216.34', family: 4 },
                    { address: '93.184.216.35', family: 4 }
                ]
            }, { timeoutMs: 1000, maxBytes: 1024, signal: preAborted.signal }),
            (error) => error?.name === 'AbortError'
        );
        assert.strictEqual(abortedRequestCount, 0, 'pre-aborted pinned download must not open a request');

        const runningAbort = new AbortController();
        const abortedDownload = requestPinnedHttp({
            url: new URL('http://cdn.example.test/image.png'),
            hostname: 'cdn.example.test',
            addresses: [
                { address: '93.184.216.34', family: 4 },
                { address: '93.184.216.35', family: 4 }
            ]
        }, { timeoutMs: 1000, maxBytes: 1024, signal: runningAbort.signal });
        runningAbort.abort();
        await assert.rejects(abortedDownload, (error) => error?.name === 'AbortError');
        assert.strictEqual(abortedRequestCount, 1, 'running abort must not try a later pinned address');
    } finally {
        restoreAbortMock();
    }
    checks.push('pinned_request_abort_stops_all_addresses');

    const restoreMismatchMock = installHttpRequestMock(createPinnedRequestMock({
        remoteAddress: '93.184.216.35',
        body: 'must-not-be-accepted'
    }));
    try {
        await expectPolicyError(
            requestPinnedHttp({
                url: new URL('http://cdn.example.test/image.png'),
                hostname: 'cdn.example.test',
                addresses: [{ address: '93.184.216.34', family: 4 }]
            }, { timeoutMs: 1000, maxBytes: 1024 }),
            'image_socket_address_mismatch'
        );
    } finally {
        restoreMismatchMock();
    }
    checks.push('socket_address_mismatch_rejected');

    const restoreConnectedMismatchMock = installHttpRequestMock(createPinnedRequestMock({
        remoteAddress: '93.184.216.35',
        body: 'must-not-be-accepted',
        alreadyConnected: true
    }));
    try {
        await expectPolicyError(
            requestPinnedHttp({
                url: new URL('http://cdn.example.test/image.png'),
                hostname: 'cdn.example.test',
                addresses: [{ address: '93.184.216.34', family: 4 }]
            }, { timeoutMs: 1000, maxBytes: 1024 }),
            'image_socket_address_mismatch'
        );
    } finally {
        restoreConnectedMismatchMock();
    }
    checks.push('already_connected_socket_mismatch_rejected');

    console.log(`network-address-policy-regression ok (${checks.length}/${checks.length}) ${checks.join(',')}`);
}

main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
});
