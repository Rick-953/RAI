'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { normalizeHostname, isPrivateOrReservedIp } = require('../lib/network-address-policy');
const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const definitions = source.slice(source.indexOf('async function validateImageUrl('), source.indexOf('function formatSearchResults('));
const { filterValidImages } = new Function('net', 'normalizeHostname', 'isPrivateOrReservedIp', definitions + ';return {filterValidImages};')(net, normalizeHostname, isPrivateOrReservedIp);
const normalizer = source.slice(source.indexOf('const CLIENT_TOOL_RESULT_ALLOWED_KEYS'), source.indexOf('function hasToolDefinition('));
const normalizeResult = new Function(normalizer + ';return normalizeClientToolResult;')();
(async () => {
    // No server HEAD requests: one unreachable CDN must not erase other results.
    assert.doesNotMatch(definitions, /fetchSafeImageHead|requestPinnedHttp|https.request|Promise.race/);
    const valid = 'https://cdn.example.com/plant.jpg?size=large';
    assert.deepEqual(await filterValidImages([valid, {url:valid}, {url:'https://cdn.example.com/flower.webp',description:'flower'}, 'file:///secret', 'http://127.0.0.1/x', 'http://[::1]/x', 'https://name:secret@example.com/x', 'http://device.local/x', 'http://10.1.2.3/x', 'https://cdn.example.com/last.png']), [valid, 'https://cdn.example.com/flower.webp', 'https://cdn.example.com/last.png']);
    assert.deepEqual(await filterValidImages(null), []);
    assert.deepEqual(await filterValidImages([valid, 'https://cdn.example.com/next.jpg'], 1), [valid]);
    for (const decision of ['denied','ignored','timed_out']) {
        const result = {success:false,error:'user_' + decision,permission_decision:decision,executed:false,retryable:false,scope:'working_directory',message:'The user did not authorize execution.'};
        assert.deepEqual(normalizeResult(result), result, 'model must receive the actual user choice');
    }
    assert.deepEqual(normalizeResult({permission_decision:'denied',system_prompt:'untrusted'}), {permission_decision:'denied'});
    console.log('search images and permission outcomes regression passed');
})().catch(error => { console.error(error); process.exit(1); });
