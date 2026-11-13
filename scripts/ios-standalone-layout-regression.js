'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'public/styles.css'), 'utf8');
const index = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const runtimeBrand = fs.readFileSync(path.join(root, 'public/runtime-brand.js'), 'utf8');

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
assert(/html\.ios-standalone \.mobile-header[\s\S]*?height: calc\(64px \+ var\(--safe-top, 0px\)\)/.test(styles), 'standalone header must reserve the top safe area');
assert(/html\.ios-standalone \.mobile-center-controls[\s\S]*?top: calc\(32px \+ var\(--safe-top, 0px\)\)/.test(styles), 'standalone model selector must be centered below the Dynamic Island');

// The root document owns the standalone paint surface, not a clipped fixed
// visual viewport. Focus plus a measured keyboard temporarily uses visualViewport.
assert(/navigator\.standalone === true[\s\S]*?classList\.add\('standalone-viewport'\)/.test(runtimeBrand), 'bootstrap must detect installed app');
assert(/screenHeight > observedMax && screenHeight - observedMax <= 120/.test(app), 'screen fallback is limited to a plausible installed-app inset');
assert(/const keyboardOpen = Boolean\(this\.activeInput\)/.test(app), 'stale visual viewport must not impersonate an open keyboard');
assert(/const appHeight = keyboardOpen \? Math\.max\(320, viewportHeight\) : Math\.max\(320, fullHeight\)/.test(app), 'unfocused shell must use full height');
assert(/html\.ios-device\.standalone-viewport,[\s\S]*?position: relative/.test(styles), 'standalone document must not be fixed to visual viewport');
assert(/html\.ios-device\.standalone-viewport \.auth-container[\s\S]*?height: var\(--app-height\)/.test(styles), 'auth surface must paint the whole installed app');
assert(!/shell\.style\.display = 'none'/.test(app), 'do not flicker the shell to force WebKit reflow');

// iOS scrolls the layout viewport when focusing the composer; the app must reset it.
assert(/this\.visualViewport\.addEventListener\('scroll', this\.handleViewportChange\)/.test(app), 'standalone iOS must observe visualViewport scroll events');
assert(/scheduleStandaloneLayoutScrollReset\(\)/.test(app) && /\[16, 50, 100, 200\]\.forEach/.test(app), 'focus transitions must schedule staggered layout-scroll resets');

// Lifecycle reconciliation must not rely only on visualViewport resize.
assert(/addEventListener\('pageshow', this\.handleViewportChange\)/.test(app));
assert(/addEventListener\('visibilitychange'/.test(app));
assert(/window\.mobileKeyboardHandler\?\.healStandaloneViewport\?\.\(\)/.test(app));

// Full-screen surfaces must not stay position:fixed inside the lying viewport.
assert(/\.sidebar \{[\s\S]*?position: absolute;[\s\S]*?height: var\(--app-height, 100dvh\)/.test(styles), 'mobile sidebar must fill the managed app height');
assert(/\.settings-modal\.active,[\s\S]*?position: absolute;[\s\S]*?height: var\(--app-height, 100dvh\)/.test(styles), 'mobile settings modal must fill the managed app height');
assert(/\.sidebar-header-fixed \{[\s\S]*?padding-top: calc\(var\(--spacing-lg\) \+ var\(--safe-top, 0px\)\)/.test(styles), 'mobile sidebar header must clear the status bar');
assert(/\.sidebar-footer-fixed \{[\s\S]*?padding-bottom: calc\(var\(--spacing-lg\) \+ var\(--safe-bottom, 0px\)\)/.test(styles), 'mobile sidebar footer must clear the home indicator');

// Composer: the safe area moves the whole composer, not the input box padding.
assert(/body\.mobile-viewport-managed \.input-area \{[\s\S]*?bottom: calc\(var\(--composer-bottom-gap, 0px\) \+ var\(--safe-bottom, 0px\)\)/.test(styles), 'composer must sit above the bottom safe area');
assert(/body\.mobile-viewport-managed \.input-container \{[\s\S]*?padding-bottom: var\(--spacing-md\)/.test(styles), 'input box must keep a compact height without the safe-area padding');
assert(/body\.mobile-viewport-managed\.keyboard-open \.input-area \{[\s\S]*?bottom: var\(--composer-bottom-gap, 0px\)/.test(styles), 'keyboard-open composer must drop the bottom safe-area offset');
assert(/html\.ios-standalone body\.mobile-viewport-managed \{ --chat-content-bottom-clearance: calc\(var\(--composer-height, 200px\) \+ var\(--spacing-md\)\)/.test(styles), 'installed PWA composer height must own its inset only once');

// Legacy 16:9 iPhones and iPads need a measured fallback when env() reports 0.
assert(/ios-legacy-16-9/.test(runtimeBrand) && /ratio >= 1\.87/.test(runtimeBrand), 'runtime must classify legacy 16:9 iPhones');
assert(/ipad-device/.test(runtimeBrand), 'runtime must classify iPads');
assert(/html\.ios-legacy-16-9 \{[\s\S]*?--safe-top: max\(20px, env\(safe-area-inset-top, 0px\)\)/.test(styles), 'legacy iPhones must fall back to a 20px status bar inset');
assert(/html\.ipad-device \{[\s\S]*?--safe-bottom: max\(20px, env\(safe-area-inset-bottom, 0px\)\)/.test(styles), 'iPads must fall back to a 20px home-indicator inset');

console.log('iOS standalone layout regression: PASS');
