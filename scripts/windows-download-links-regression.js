const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const stylesCss = fs.readFileSync(path.join(root, 'public/styles.css'), 'utf8');
const swJs = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');

const appBundleUrl = 'https://github.com/Master-Tea/CX-RAI/releases/download/v1.1.1/CX.RAI_1.1.1.0_x86_x64_arm.appxbundle';
const certificateUrl = 'https://github.com/Master-Tea/CX-RAI/releases/download/v1.1.1/CX.RAI_1.1.1.0_x86_x64_arm.cer';
const buildId = '20260729-release-safety-password-v01158';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(indexHtml.includes('settings-platform-download-card'), 'Combined platform download card is missing from About settings');
assert(indexHtml.includes('settings-macos-title'), 'macOS download heading is missing');
assert(indexHtml.includes(appBundleUrl), 'Windows app package URL is missing or changed');
assert(indexHtml.includes(certificateUrl), 'Windows certificate URL is missing or changed');
assert(indexHtml.includes('data-i18n="settings-platform-download"'), 'Platform download translation binding is missing');
assert(indexHtml.includes('data-i18n="settings-windows-certificate"'), 'Windows certificate translation binding is missing');
assert(indexHtml.includes('settings-install-tutorial'), 'Install tutorial disclosure is missing');
for (const key of ['settings-macos-title', 'settings-windows-title', 'settings-platform-download', 'settings-windows-certificate', 'settings-install-tutorial']) {
  assert((appJs.match(new RegExp(`['"]${key}['"]`, 'g')) || []).length >= 3, `${key} must exist in Chinese, English, and Traditional Chinese dictionaries`);
}
assert(stylesCss.includes('.settings-platform-downloads'), 'Platform download layout styles are missing');
assert(stylesCss.includes('.settings-windows-actions'), 'Windows download action styles are missing');
assert(stylesCss.includes('.settings-install-tutorial'), 'Install tutorial styles are missing');
assert(swJs.includes(`const RAI_SW_VERSION = '0.11.58-${buildId}'`), 'Service Worker build marker is stale');
assert(!indexHtml.includes('20260726-gpt56-luna-route-v01147-r4'), 'index.html still references the previous build cache');
assert(!swJs.includes('20260726-gpt56-luna-route-v01147-r4'), 'sw.js still references the previous build cache');

console.log('Windows download links regression passed');
