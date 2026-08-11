'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  FALLBACK_RELEASE,
  GITHUB_LATEST_RELEASE_URL,
  createWindowsDownloadsResolver,
  parseLatestRelease
} = require('../lib/windows-downloads');

const root = path.resolve(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const serverJs = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const stylesCss = fs.readFileSync(path.join(root, 'public/styles.css'), 'utf8');
const swJs = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const buildMatch = appJs.match(/const RAI_BUILD_ID = '([^']+)'/);
assert(buildMatch, 'app.js build marker is missing');
const buildId = buildMatch[1];

assert(indexHtml.includes('settings-platform-download-card'), 'Combined platform download card is missing from About settings');
for (const id of ['windowsPackageDownload', 'windowsCertificateDownload', 'windowsDownloadStatus']) {
  assert(indexHtml.includes(`id="${id}"`), `${id} is missing`);
}
assert(appJs.includes('loadLatestWindowsDownloads()'), 'About does not automatically load the latest Windows release');
assert(appJs.includes('`${API_BASE}/windows-downloads`'), 'frontend does not call the same-origin Windows release API');
assert(appJs.includes("parsed.pathname.startsWith('/Master-Tea/CX-RAI/releases/download/')"), 'frontend asset origin validation is missing');
assert(serverJs.includes("app.get('/api/windows-downloads'"), 'Windows release API route is missing');
assert(serverJs.includes("require('./lib/windows-downloads')"), 'server does not use the bounded release resolver');
assert(indexHtml.includes(FALLBACK_RELEASE.package.url), 'fallback Windows package URL is missing');
assert(indexHtml.includes(FALLBACK_RELEASE.certificate.url), 'fallback certificate URL is missing');
assert(stylesCss.includes('.settings-platform-downloads'), 'Platform download layout styles are missing');
assert(stylesCss.includes('.settings-windows-actions'), 'Windows download action styles are missing');
assert(swJs.includes(`const RAI_SW_VERSION = '${packageJson.version}-${buildId}'`), 'Service Worker build marker is stale');

(async () => {
  const latestPayload = {
    tag_name: 'v1.3.16.10',
    draft: false,
    assets: [
      { name: 'CX.RAI_1.3.16.10_x86_x64_arm.appxbundle', browser_download_url: 'https://github.com/Master-Tea/CX-RAI/releases/download/v1.3.16.10/CX.RAI_1.3.16.10_x86_x64_arm.appxbundle' },
      { name: 'CX.RAI_1.3.16.10_x86_x64_arm.cer', browser_download_url: 'https://github.com/Master-Tea/CX-RAI/releases/download/v1.3.16.10/CX.RAI_1.3.16.10_x86_x64_arm.cer' },
      { name: 'evil.appxbundle', browser_download_url: 'https://example.com/evil.appxbundle' }
    ]
  };
  const parsed = parseLatestRelease(latestPayload);
  assert.equal(parsed.tag, 'v1.3.16.10');
  assert.equal(parsed.package.name, 'CX.RAI_1.3.16.10_x86_x64_arm.appxbundle');
  assert.equal(parsed.certificate.name, 'CX.RAI_1.3.16.10_x86_x64_arm.cer');

  let fetchCount = 0;
  const resolver = createWindowsDownloadsResolver({
    fetchImpl: async (url) => {
      fetchCount += 1;
      assert.equal(url, GITHUB_LATEST_RELEASE_URL);
      return { ok: true, status: 200, json: async () => latestPayload };
    },
    now: () => 1000
  });
  assert.equal((await resolver()).tag, 'v1.3.16.10');
  assert.equal((await resolver()).tag, 'v1.3.16.10');
  assert.equal(fetchCount, 1, 'latest release should be cached');

  const fallbackResolver = createWindowsDownloadsResolver({
    fetchImpl: async () => { throw new Error('offline'); }
  });
  assert.equal((await fallbackResolver()).source, 'fallback');

  console.log('Windows download links regression passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
