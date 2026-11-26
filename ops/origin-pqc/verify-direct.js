'use strict';

// Usage: node verify-direct.js <direct IP> <port> <hostname> [...]
// Supply the production name as SNI even when testing a loopback listener.
const assert = require('node:assert/strict');
const net = require('node:net');
const tls = require('node:tls');

const [address, rawPort, ...names] = process.argv.slice(2);
const port = Number(rawPort);
if (!net.isIP(address) || !Number.isInteger(port) || port < 1 || port > 65535 ||
    !names.length || names.some(name => !/^[a-z0-9.-]+$/i.test(name))) {
    throw new Error('Expected a direct IP, a TCP port and one or more DNS hostnames.');
}
const profiles = [
    ['hybrid', { minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', ecdhCurve: 'X25519MLKEM768' }],
    ['classical', { minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2', ecdhCurve: 'P-256' }]
];

function probe(name, options) {
    return new Promise((resolve, reject) => {
        const socket = tls.connect({ ...options, host: address, port, servername: name,
            rejectUnauthorized: true, ALPNProtocols: ['http/1.1'] });
        const timeout = setTimeout(() => socket.destroy(new Error('TLS/HTTP probe timeout')), 8000);
        let headers = '';
        socket.once('secureConnect', () => {
            socket.write(`HEAD / HTTP/1.1\r\nHost: ${name}\r\nConnection: close\r\n\r\n`);
        });
        socket.on('data', data => {
            headers += data.toString('latin1');
            if (headers.length > 16384) return socket.destroy(new Error('HTTP headers too large'));
            const match = /^HTTP\/1\.[01] (\d{3})[^\r\n]*\r\n/.exec(headers);
            if (match) {
                const result = { protocol: socket.getProtocol(), status: Number(match[1]),
                    certificate: socket.getPeerCertificate().fingerprint256 };
                resolve(result);
                socket.destroy();
            }
        });
        socket.once('error', reject);
        socket.once('close', () => { clearTimeout(timeout); reject(new Error('Connection closed before HTTP status')); });
    });
}

(async () => {
    for (const name of names) {
        let previous;
        for (const [profile, options] of profiles) {
            const result = await probe(name, options);
            console.log(name, profile, result.protocol, result.status, result.certificate);
            if (previous) {
                assert.equal(result.status, previous.status, 'HTTP routing changed between handshakes');
                assert.equal(result.certificate, previous.certificate, 'Certificate changed between handshakes');
            }
            previous = result;
        }
    }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
