'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const tls = require('node:tls');
const { postGatewayJson } = require('../lib/gpt-gateway');

const host = '127.0.0.1';
const hybrid = 'X25519MLKEM768';
const hybridGroupId = '4588';
const fixtureKey = 'local-gateway-fixture';
const proxyAuth = 'Basic ' + Buffer.from('fixture:loopback').toString('base64');
const firstEvent = 'data: {"choices":[{"delta":{"content":"loopback"}}]}\n\n';
const doneEvent = 'data: [DONE]\n\n';

function supportsHybrid() {
    try {
        tls.createSecureContext({ ecdhCurve: hybrid });
        return true;
    } catch (error) {
        if (error.code !== 'ERR_CRYPTO_OPERATION_FAILED') throw error;
        return false;
    }
}

async function gatewayRequest(baseUrl, protocol, mode) {
    assert.equal(new URL(baseUrl).hostname, host);
    const controller = new AbortController();
    const response = await postGatewayJson({
        baseUrl, endpoint: 'chat/completions', apiKey: fixtureKey,
        body: { model: mode, stream: true },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)])
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-loopback-protocol'), protocol);
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    if (mode === 'cancel') {
        const reader = response.body.getReader();
        assert.equal(Buffer.from((await reader.read()).value).toString(), firstEvent);
        controller.abort();
        await assert.rejects(reader.read(), { name: 'AbortError' });
    } else {
        assert.equal(await response.text(), firstEvent + doneEvent);
    }
}

async function serveGateway(req, res) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions' || req.headers.authorization !== `Bearer ${fixtureKey}`) {
        res.writeHead(400).end();
        return;
    }
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'X-Loopback-Protocol': req.socket.encrypted ? req.socket.getProtocol() : 'http'
    });
    if (JSON.parse(Buffer.concat(chunks)).model === 'cancel') res.write(firstEvent);
    else res.end(firstEvent + doneEvent);
}

async function verify() {
    const hasHybrid = supportsHybrid();
    const runtime = `Node ${process.version} / OpenSSL ${process.versions.openssl}`;
    if (!hasHybrid && process.argv.includes('--require-hybrid')) {
        throw new Error(`${runtime} cannot enable ${hybrid}. Use the release Node runtime.`);
    }

    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rai-model-tls-'));
    const keyFile = path.join(temp, 'key.pem');
    const certFile = path.join(temp, 'cert.pem');
    const logFile = path.join(temp, 'probe.log');
    const servers = [];
    const sockets = new Set();
    const system = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(path|systemroot|ld_library_path)$/i.test(name)));
    const nodeEnv = { ...system, ...Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(node_options|openssl_conf|openssl_modules)$/i.test(name))) };

    async function listen(server, scheme) {
        servers.push(server);
        server.on('connection', socket => {
            sockets.add(socket);
            socket.once('close', () => sockets.delete(socket));
        });
        await once(server.listen(0, host), 'listening');
        return `${scheme}://${host}:${server.address().port}`;
    }

    async function probe(base, protocol, { mode = 'complete', trace = false, trust = true, env = {} } = {}) {
        const output = fs.openSync(logFile, 'w');
        let child;
        try {
            child = spawn(process.execPath, [
                ...process.execArgv, ...(trace ? ['--trace-tls'] : []),
                __filename, '--loopback-request', base + '/v1', protocol, mode
            ], {
                env: { ...nodeEnv, NODE_EXTRA_CA_CERTS: trust ? certFile : '', ...env },
                stdio: ['ignore', 'ignore', output], timeout: 10000
            });
        } finally {
            fs.closeSync(output);
        }
        const [code, signal] = await once(child, 'close');
        const stderr = fs.readFileSync(logFile, 'utf8');
        if (code !== 0) throw Object.assign(new Error(`Loopback request failed (${signal || code})`), { stderr });
        return stderr;
    }

    try {
        execFileSync(process.env.OPENSSL_BIN || 'openssl', [
            'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
            '-keyout', keyFile, '-out', certFile, '-days', '1', '-subj', '/CN=localhost', '-addext', `subjectAltName=IP:${host}`
        ], { env: { ...system, MSYS2_ARG_CONV_EXCL: '*' }, timeout: 10000, stdio: ['ignore', 'ignore', 'pipe'] });
        const identity = { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
        const legacyTls = { ...identity, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2', ecdhCurve: 'P-256' };
        const classicTls = { ...identity, minVersion: 'TLSv1.3', ecdhCurve: 'X25519' };
        const base = await listen(https.createServer({ ...classicTls, ecdhCurve: hasHybrid ? hybrid : 'X25519' }, serveGateway), 'https');
        const classicBase = hasHybrid ? await listen(https.createServer(classicTls, serveGateway), 'https') : base;
        const legacyBase = await listen(https.createServer(legacyTls, serveGateway), 'https');
        const httpBase = await listen(http.createServer(serveGateway), 'http');

        const trace = await probe(base, 'TLSv1.3', { trace: hasHybrid, mode: 'cancel' });
        if (hasHybrid) {
            const [, clientHello, serverHello] = trace.split(/(?:ClientHello|ServerHello),/);
            const shares = [...(clientHello || '').matchAll(/NamedGroup: \S+ \((\d+)\)/g)].map(match => match[1]);
            assert.deepEqual(shares.slice(0, 2), [hybridGroupId, '29'], `Client must offer ${hybrid} then X25519`);
            assert.equal(serverHello?.match(/NamedGroup: \S+ \((\d+)\)/)?.[1], hybridGroupId, `Server must select ${hybrid}`);
        }
        console.log(`${runtime}: direct TLS 1.3 ${hasHybrid ? hybrid + ' first key share and negotiated' : 'X25519 (hybrid unavailable)'}, SSE cancellation passed`);

        await probe(classicBase, 'TLSv1.3');
        await probe(legacyBase, 'TLSv1.2');
        await probe(httpBase, 'http');
        await assert.rejects(probe(base, 'TLSv1.3', { trust: false }), error => /DEPTH_ZERO_SELF_SIGNED_CERT/.test(error.stderr || ''));
        console.log('TLS 1.3/X25519, TLS 1.2/P-256, plain HTTP, SSE completion, certificate rejection passed');

        if (process.allowedNodeEnvironmentFlags.has('--use-env-proxy')) {
            const authority = new URL(base).host;
            const legacyAuthority = new URL(legacyBase).host;
            for (const scheme of ['http', 'https']) {
                const proxy = scheme === 'https' ? https.createServer(legacyTls) : http.createServer();
                let tunnels = 0;
                proxy.on('connect', (req, socket, head) => {
                    if (![authority, legacyAuthority].includes(req.url) || req.headers['proxy-authorization'] !== proxyAuth) {
                        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
                        return;
                    }
                    tunnels += 1;
                    const upstream = net.connect(Number(req.url.split(':')[1]), host, () => {
                        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                        if (head.length) upstream.write(head);
                        socket.pipe(upstream).pipe(socket);
                    });
                    upstream.once('error', () => socket.destroy());
                    socket.once('error', () => upstream.destroy());
                    socket.once('close', () => upstream.destroy());
                });
                const proxyUrl = new URL(await listen(proxy, scheme));
                proxyUrl.username = 'fixture';
                proxyUrl.password = 'loopback';
                const proxyVariable = scheme === 'http' ? 'HTTP_PROXY' : 'HTTPS_PROXY';
                const env = { NODE_USE_ENV_PROXY: '1', [proxyVariable]: proxyUrl.href };
                await probe(base, 'TLSv1.3', { env });
                await probe(legacyBase, 'TLSv1.2', { env });
                assert.equal(tunnels, 2);
                await probe(base, 'TLSv1.3', { env: { ...env, NO_PROXY: authority } });
                assert.equal(tunnels, 2, 'NO_PROXY must bypass the proxy');
                console.log(`${scheme.toUpperCase()} authenticated CONNECT${scheme === 'https' ? ' (outer TLS 1.2)' : ''} → ${hasHybrid ? hybrid : 'X25519'} TLS 1.3 / P-256 TLS 1.2, NO_PROXY passed`);
            }
        } else {
            await probe(base, 'TLSv1.3', { env: { NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: httpBase } });
            console.log('Runtime without native fetch env-proxy: direct request preserved');
        }
    } finally {
        for (const socket of sockets) socket.destroy();
        await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
        fs.rmSync(keyFile, { force: true });
        fs.rmSync(certFile, { force: true });
        fs.rmSync(logFile, { force: true });
        fs.rmdirSync(temp);
    }
}

const run = process.argv[2] === '--loopback-request' ? gatewayRequest(...process.argv.slice(3)) : verify();
run.catch(error => {
    console.error(error.stderr?.trim().split('\n').slice(-14).join('\n') || error);
    process.exitCode = 1;
});
