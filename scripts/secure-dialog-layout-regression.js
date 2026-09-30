'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const css = read('public/secure-sharing.css'), script = read('public/secure-sharing.js');
assert.match(css, /\.rai-secure-dialog\s*\{[^}]*margin:\s*auto;/, 'dialog must override the global margin:0 reset');
assert.match(css, /\.rai-secure-dialog\s*\{[^}]*overflow-y:\s*auto;/, 'short viewports need scrollable dialogs');
assert.match(css, /\.rai-qr-slot\s*\{[^}]*aspect-ratio:\s*1;/, 'expired image hiding must not collapse the QR slot');
assert.match(css, /100dvh/); assert.match(css, /safe-area-inset-bottom/);
assert.match(script, /slot\.append\(image\)/); assert.match(script, /d\.append\(slot, status\)/);
assert.match(script, /d\.setAttribute\('aria-labelledby', h\.id\)/);
const html = read('public/index.html'), sw = read('public/sw.js');
const version = /secure-sharing\.js\?v=([a-z0-9-]+)/.exec(html)?.[1];
assert.ok(version); assert.ok(read('public/app.js').includes("const RAI_BUILD_ID = '" + version + "'"), 'application and cache build markers must match'); assert.ok(sw.includes('secure-sharing.js?v=' + version)); assert.ok(sw.includes('secure-sharing.css?v=' + version));
console.log('secure-dialog layout contracts PASS: reset override, stable QR slot, viewport overflow, accessible title, versioned offline assets (browser geometry is separately measured)');

const styles = read('public/styles.css');
for (const id of ['qrLoginButton', 'authPasskeyBtn', 'customApiToggleBtn']) {
  assert.match(html, new RegExp('class="auth-alt-button" id="' + id + '"'), 'all login choices share the plain button style');
}
assert.match(styles, /\.auth-alternative-options\s*\{[^}]*gap:\s*10px;/);
assert.match(styles, /\.auth-alternative-row\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);[^}]*gap:\s*10px;/);
assert.match(styles, /\.auth-alt-button\s*\{[^}]*border:\s*0;[^}]*border-radius:\s*10px;[^}]*box-shadow:\s*none;/);
assert.match(styles, /\.auth-alt-button:active:not\(:disabled\)\s*\{\s*transform:\s*scale\(0\.97\);/);
assert.match(styles, /@media \(max-width: 420px\)\s*\{\s*\.auth-alternative-row \{ grid-template-columns: minmax\(0, 1fr\);/);
assert.match(styles, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.auth-alt-button \{ transition: none;/);
console.log('plain login choice contracts PASS: shared borderless buttons, explicit spacing, responsive grid, press scale and reduced motion');

assert.match(html, /id="authFooter"[\s\S]*?id="authSwitch"[\s\S]*?id="authLangRow"/);
assert.match(styles, /\.auth-lang-row\s*\{[^}]*flex:\s*0 0 auto;/);
assert.match(html, /class="sidebar-header-controls"[\s\S]*?temp-chat-top-btn[\s\S]*?id="qrScanButton"/);
for (const asset of ['lib/jsQR.js', 'qr-scanner.js']) {
  assert.ok(html.includes(asset + '?v=' + version)); assert.ok(sw.includes(asset + '?v=' + version));
}
console.log('scanner/footer contracts PASS: compact footer, sidebar adjacency, same-version local decoder and scanner cache');

assert.match(css, /\.rai-secure-dialog:focus\s*\{\s*outline:\s*none;/, 'suppress the whole-card browser focus ring');
assert.match(css, /button:focus-visible[\s\S]*?outline:\s*2px/, 'keep keyboard focus rings on actual controls');
assert.match(css, /\.rai-qr-toast\s*\{[^}]*width:\s*max-content;[^}]*max-width:\s*min\(320px/, 'QR success notice fits its text instead of using a full-width popup');
assert.match(script, /cleanup\(\); approveScan\(payload, context, d\)/, 'reuse the original open dialog');
assert.doesNotMatch(script, /cleanup\(\); d\.close\(\); approveScan/, 'scan must never close then open a new approval card');
console.log('QR card contracts PASS: same-dialog handoff, container-only outline removal, keyboard focus and compact notice');
