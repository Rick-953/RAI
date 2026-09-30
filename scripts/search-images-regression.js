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
let redirect = null;
const png = Buffer.from('89504e470d0a1a0a', 'hex');
const resolveSafeHttpTarget = async (raw) => {
  const url = new URL(raw);
  assert.equal(url.hostname, 'cdn.example.com');
  return { url, hostname: url.hostname, addresses: [{ address: '93.184.216.34', family: 4 }] };
};
const requestPinnedHttp = async (target) => {
  fetchCount += 1;
  if (redirect && target.url.pathname === "/redirect") return {statusCode:302,headers:{location:redirect},buffer:Buffer.alloc(0)};
  return { statusCode: 200, headers: { 'content-type': 'image/png', 'content-length': String(png.length) }, buffer: png };
};
const { filterValidImages, cacheSearchImage, buildSearchImageCacheUrl, maintainSearchImageCache } = new Function(
  'crypto', 'fs', 'path', 'net', 'normalizeHostname', 'isPrivateOrReservedIp',
  'resolveSafeHttpTarget', 'requestPinnedHttp', 'sanitizeReportContext',
  'sniffImageBuffer', 'validateGeneratedImageBuffer', 'SEARCH_IMAGE_CACHE_DIR',
  'SEARCH_IMAGE_CACHE_PUBLIC_PREFIX', 'SEARCH_IMAGE_CACHE_TTL_MS', 'MAX_SEARCH_IMAGE_BYTES', 'SEARCH_IMAGE_FETCH_TIMEOUT_MS',
  'Date', 'MAX_SEARCH_IMAGE_CACHE_BYTES',
  `${definitions}; return { filterValidImages, cacheSearchImage, buildSearchImageCacheUrl, maintainSearchImageCache };`
)(crypto, fs, path, net, normalizeHostname, isPrivateOrReservedIp, resolveSafeHttpTarget, requestPinnedHttp, String,
  (buffer) => ({ contentType: 'image/png', ext: 'png' }),
  (buffer, contentType) => { assert.equal(contentType, 'image/png'); return { contentType: 'image/png', ext: 'png' }; },
  tempDir, '/search-images', 1000, 1024, 1000,
  class extends Date { static now() { return Math.max(now, Date.now()); } }, 32);
(async () => {
  try {
    const src = 'https://cdn.example.com/plant.jpg?size=large';
    const expected = buildSearchImageCacheUrl(src);
    const first = await filterValidImages([src, { url: src }, 'file:///secret', 'http://127.0.0.1/x', 'https://name:secret@example.com/x']);
    assert.deepEqual(first, [expected], 'only validated results should rewrite to a same-origin cache URL');
    assert.equal(fetchCount, 1);
    assert.deepEqual(await fs.promises.readFile(path.join(tempDir, path.basename(expected))), png);
    assert.deepEqual(await filterValidImages([src]), [expected]);
    assert.equal(fetchCount, 1, 'cache hit must not redownload');
    const cachedPath = path.join(tempDir, path.basename(expected));
    const old = new Date(now - 2000);
    await fs.promises.utimes(cachedPath, old, old);
    now += 1001;
    assert.deepEqual(await filterValidImages([src]), [expected]);
    assert.equal(fetchCount, 2, 'expired file must be refreshed from its source');
    assert.deepEqual(await filterValidImages(Array.from({ length: 8 }, (_, i) => `https://cdn.example.com/${i}.png`), 2), [
      buildSearchImageCacheUrl('https://cdn.example.com/0.png'), buildSearchImageCacheUrl('https://cdn.example.com/1.png')
    ], 'rewrite count is bounded');
    redirect='https://cdn.example.com/final.png';
    assert.ok(await cacheSearchImage('https://cdn.example.com/redirect'));
    redirect='http://127.0.0.1/secret';
    assert.equal(await cacheSearchImage('https://cdn.example.com/redirect?blocked'),null,'redirect SSRF must be rejected');
    const countBefore=fetchCount;
    await Promise.all(Array.from({length:10},()=>cacheSearchImage('https://cdn.example.com/dedup.png')));
    assert.equal(fetchCount,countBefore+1,'concurrent identical downloads coalesce');
    for(let i=0;i<10;i++) await cacheSearchImage('https://cdn.example.com/budget'+i+'.png');
    const used=(await Promise.all(fs.readdirSync(tempDir).map(n=>fs.promises.lstat(path.join(tempDir,n))))).reduce((n,st)=>n+st.size,0);
    assert.ok(used<=32,'aggregate disk budget is enforced during commits');
    now+=2000; await maintainSearchImageCache();
    assert.equal(fs.readdirSync(tempDir).length,0,'scheduled cleanup removes unrequested expired files');
    // Exercise the production delivery handler through actual Express and HTTP.
    now=Date.now(); await cacheSearchImage(src);
    const express=require('express'), http=require('node:http'); const app=express();
    const routeStart=source.indexOf('app.get(`${SEARCH_IMAGE_CACHE_PUBLIC_PREFIX}/:filename`');
    const routeEnd=source.indexOf('app.get(`${GENERATED_IMAGE_PUBLIC_PREFIX}',routeStart);
    new Function('app','fs','path','crypto','sniffImageBuffer','SEARCH_IMAGE_CACHE_PUBLIC_PREFIX','SEARCH_IMAGE_CACHE_DIR','SEARCH_IMAGE_CACHE_TTL_MS','MAX_SEARCH_IMAGE_BYTES',source.slice(routeStart,routeEnd))(app,fs,path,crypto,()=>({contentType:'image/png'}),'/search-images',tempDir,1000,1024);
    const server=http.createServer(app); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    try {
      const url='http://127.0.0.1:'+server.address().port+expected;
      const response=await fetch(url); assert.equal(response.status,200); assert.equal(response.headers.get('content-type'),'image/png'); assert.equal(response.headers.get('x-content-type-options'),'nosniff');
      const etag=response.headers.get('etag'); assert.deepEqual(Buffer.from(await response.arrayBuffer()),png);
      assert.equal((await fetch(url,{headers:{'If-None-Match':etag}})).status,304);
      assert.equal((await fetch(url.replace(/[^/]+$/,'malformed.img'))).status,404);
      fs.utimesSync(path.join(tempDir,path.basename(expected)),new Date(Date.now()-2000),new Date(Date.now()-2000));
      assert.equal((await fetch(url)).status,404);
    } finally { await new Promise(resolve=>server.close(resolve)); }
    console.log('search image cache rewrite, reuse, expiry refresh, SSRF rejection, and limits passed');
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exit(1); });


