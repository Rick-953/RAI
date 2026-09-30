'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { normalizeHostname, isPrivateOrReservedIp } = require('../lib/network-address-policy');
const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const start = source.indexOf('async function validateImageUrl(');
const end = source.indexOf('function formatSearchResults(', start);
const definitions = source.slice(start, end);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rai-search-image-'));
let now = Date.now();
let fetchCount = 0;
const png = Buffer.from('89504e470d0a1a0a', 'hex');
const resolveSafeHttpTarget = async (raw) => {
  const url = new URL(raw);
  assert.equal(url.hostname, 'cdn.example.com');
  return { url, hostname: url.hostname, addresses: [{ address: '93.184.216.34', family: 4 }] };
};
const requestPinnedHttp = async () => {
  fetchCount += 1;
  return { statusCode: 200, headers: { 'content-type': 'image/png', 'content-length': String(png.length) }, buffer: png };
};
const { filterValidImages, cacheSearchImage, buildSearchImageCacheUrl } = new Function(
  'crypto', 'fs', 'path', 'net', 'normalizeHostname', 'isPrivateOrReservedIp',
  'resolveSafeHttpTarget', 'requestPinnedHttp', 'sanitizeReportContext',
  'sniffImageBuffer', 'validateGeneratedImageBuffer', 'SEARCH_IMAGE_CACHE_DIR',
  'SEARCH_IMAGE_CACHE_PUBLIC_PREFIX', 'SEARCH_IMAGE_CACHE_TTL_MS', 'MAX_SEARCH_IMAGE_BYTES', 'SEARCH_IMAGE_FETCH_TIMEOUT_MS',
  'Date',
  `${definitions}; return { filterValidImages, cacheSearchImage, buildSearchImageCacheUrl };`
)(crypto, fs, path, net, normalizeHostname, isPrivateOrReservedIp, resolveSafeHttpTarget, requestPinnedHttp, String,
  (buffer) => ({ contentType: 'image/png', ext: 'png' }),
  (buffer, contentType) => { assert.equal(contentType, 'image/png'); return { contentType: 'image/png', ext: 'png' }; },
  tempDir, '/search-images', 1000, 1024, 1000,
  class extends Date { static now() { return now; } });
(async () => {
  try {
    const src = 'https://cdn.example.com/plant.jpg?size=large';
    const expected = buildSearchImageCacheUrl(src);
    const first = await filterValidImages([src, { url: src }, 'file:///secret', 'http://127.0.0.1/x', 'https://user:pass@cdn.example.com/x']);
    assert.deepEqual(first, [expected], 'only validated results should rewrite to a same-origin cache URL');
    assert.equal(fetchCount, 1);
    assert.deepEqual(await fs.promises.readFile(path.join(tempDir, path.basename(expected))), png);
    assert.deepEqual(await filterValidImages([src]), [expected]);
    assert.equal(fetchCount, 1, 'cache hit must not redownload');
    now += 1001;
    assert.deepEqual(await filterValidImages([src]), [expected]);
    assert.equal(fetchCount, 2, 'expired file must be refreshed from its source');
    assert.deepEqual(await filterValidImages(Array.from({ length: 8 }, (_, i) => `https://cdn.example.com/${i}.png`), 2), [
      buildSearchImageCacheUrl('https://cdn.example.com/0.png'), buildSearchImageCacheUrl('https://cdn.example.com/1.png')
    ], 'rewrite count is bounded');
    console.log('search image cache rewrite, reuse, expiry refresh, SSRF rejection, and limits passed');
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exit(1); });
