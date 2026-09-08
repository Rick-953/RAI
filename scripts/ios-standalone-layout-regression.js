'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'public/styles.css'), 'utf8');
const index = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(`iOS standalone layout regression: ${message}`);
}

assert(/viewport-fit=cover/.test(index), 'viewport-fit=cover must remain enabled for notch devices');
assert(/display-mode:\s*standalone/.test(app) && /navigator\?\.standalone\s*===\s*true/.test(app), 'standalone mode must be detected on iOS');
assert(/this\.visualViewport && \(!this\.isIOS \|\| this\.isStandalone\)/.test(app), 'standalone iOS must subscribe to visualViewport resize');
assert(/const useVisualViewport = Boolean\(this\.visualViewport && \(!this\.isIOS \|\| this\.isStandalone\)\)/.test(app), 'standalone iOS must calculate app height from the visual viewport');
assert(/\.app-container \{[\s\S]*?height: var\(--app-height, 100dvh\)/.test(styles), 'mobile app shell must use the managed app height');
assert(/html\.mobile-viewport-managed,[\s\S]*?max-height: var\(--app-height\)/.test(styles), 'managed viewport must clamp document height');
assert(/html,[\s\S]*?inset: 0;/.test(styles), 'fixed iOS document must be pinned to all viewport edges');
assert(/html\.ios-standalone \.mobile-header[\s\S]*?height: calc\(64px \+ env\(safe-area-inset-top, 0px\)\)/.test(styles), 'standalone header must reserve the top safe area');
assert(/html\.ios-standalone \.mobile-center-controls[\s\S]*?top: calc\(32px \+ env\(safe-area-inset-top, 0px\)\)/.test(styles), 'standalone model selector must be centered below the Dynamic Island');

console.log('iOS standalone layout regression: PASS');
