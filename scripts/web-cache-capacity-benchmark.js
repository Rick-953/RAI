'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ args: ['--enable-precise-memory-info'] });
  try {
    const page = await browser.newPage();
    await page.route('http://localhost/', route => route.fulfill({ contentType: 'text/html', body: '<title>Cache benchmark</title>' }));
    await page.goto('http://localhost/');
    await page.addScriptTag({ path: path.join(__dirname, '../public/conversation-cache.js') });
    const result = await page.evaluate(async () => {
      window.RAI_API_BASE = '/api';
      const cache = window.RAIConversationCache;
      await cache.openForUser(1);
      const mib = 1024 * 1024;
      const text = 'x'.repeat(4 * mib);
      for (let index = 0; index < 30; index++) await cache.putConversation('large-' + index, [text], 1, '');
      for (let index = 0; index < 10; index++) {
        if (!await cache.putAsset('image-' + index, new Blob([new Uint8Array(12 * mib)]))) throw new Error('Insufficient browser storage');
      }
      const bytes = await cache.usage();
      let peak = performance.memory.usedJSHeapSize;
      const sample = setInterval(() => { peak = Math.max(peak, performance.memory.usedJSHeapSize); }, 10);
      const start = performance.now();
      for (let index = 0; index < 50; index++) await cache.putConversation('small-' + index, ['small'], 1, '', { touch: false });
      clearInterval(sample);
      return { mib: Math.round(bytes / mib), writes: 50, elapsedMs: Math.round(performance.now() - start), sampledPeakJsHeapMiB: Math.round(peak / mib) };
    });
    assert.equal(result.mib, 240);
    console.log(JSON.stringify(result));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
