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

// Cold-start viewport lie: 100dvh/visualViewport.height under-report the top inset in
// standalone mode; screen.height is used to correct the full-screen height.
assert(/navigator\.standalone === true[\s\S]*?classList\.add\('standalone-viewport'\)/.test(runtimeBrand), 'runtime bootstrap must detect the standalone viewport');
assert(/screenHeight > observedMax && screenHeight - observedMax <= 120/.test(runtimeBrand), 'standalone bootstrap must correct the full-screen height from screen.height');
assert(/screenHeight > observedMax && screenHeight - observedMax <= 120/.test(app), 'standalone viewport sync must correct the full-screen height from screen.height');
assert(/const keyboardOpen = Boolean\(this\.activeInput\) \|\| keyboardHeight > 120/.test(app), 'standalone keyboard detection must fall back to the focused input');
assert(/keyboardOpen\s*\n?\s*\? `\$\{Math\.max\(320, viewportHeight\)\}px`/.test(app), 'standalone keyboard-open state must switch back to the visual viewport height');

// iOS scrolls the layout viewport when focusing the composer; the app must reset it.
assert(/this\.visualViewport\.addEventListener\('scroll', this\.handleViewportChange\)/.test(app), 'standalone iOS must observe visualViewport scroll events');
assert(/scheduleStandaloneLayoutScrollReset\(\)/.test(app) && /\[16, 50, 100, 200\]\.forEach/.test(app), 'focus transitions must schedule staggered layout-scroll resets');

// Stuck-viewport healing: a display flip forces WebKit to re-measure the screen height.
assert(/healStandaloneViewport\(\) \{[\s\S]*?screenHeight - currentHeight[\s\S]*?shell\.style\.display = 'none'/.test(app), 'standalone iOS must heal a stuck viewport');
assert(/window\.setTimeout\(\(\) => this\.healStandaloneViewport\(\), 350\)/.test(app), 'viewport healing must run after startup');
assert(/window\.mobileKeyboardHandler\?\.healStandaloneViewport\?\.\(\)/.test(app), 'viewport healing must run when the app becomes visible');
assert(/installViewportDebugOverlay\(\)/.test(app) && /viewport-debug/.test(app), 'a viewport debug overlay must be available for on-device diagnosis');

// Full-screen surfaces must not stay position:fixed inside the lying viewport.
assert(/\.sidebar \{[\s\S]*?position: absolute;[\s\S]*?height: var\(--app-height, 100dvh\)/.test(styles), 'mobile sidebar must fill the managed app height');
assert(/\.settings-modal\.active,[\s\S]*?position: absolute;[\s\S]*?height: var\(--app-height, 100dvh\)/.test(styles), 'mobile settings modal must fill the managed app height');
assert(/\.sidebar-header-fixed \{[\s\S]*?padding-top: calc\(var\(--spacing-lg\) \+ var\(--safe-top, 0px\)\)/.test(styles), 'mobile sidebar header must clear the status bar');
assert(/\.sidebar-footer-fixed \{[\s\S]*?padding-bottom: calc\(var\(--spacing-lg\) \+ var\(--safe-bottom, 0px\)\)/.test(styles), 'mobile sidebar footer must clear the home indicator');

// Composer: the safe area moves the whole composer, not the input box padding.
assert(/body\.mobile-viewport-managed \.input-area \{[\s\S]*?bottom: calc\(var\(--composer-bottom-gap, 0px\) \+ var\(--safe-bottom, 0px\)\)/.test(styles), 'composer must sit above the bottom safe area');
assert(/body\.mobile-viewport-managed \.input-container \{[\s\S]*?padding-bottom: var\(--spacing-md\)/.test(styles), 'input box must keep a compact height without the safe-area padding');
assert(/body\.mobile-viewport-managed\.keyboard-open \.input-area \{[\s\S]*?bottom: var\(--composer-bottom-gap, 0px\)/.test(styles), 'keyboard-open composer must drop the bottom safe-area offset');

// Legacy 16:9 iPhones and iPads need a measured fallback when env() reports 0.
assert(/ios-legacy-16-9/.test(runtimeBrand) && /ratio >= 1\.87/.test(runtimeBrand), 'runtime must classify legacy 16:9 iPhones');
assert(/ipad-device/.test(runtimeBrand), 'runtime must classify iPads');
assert(/html\.ios-legacy-16-9 \{[\s\S]*?--safe-top: max\(20px, env\(safe-area-inset-top, 0px\)\)/.test(styles), 'legacy iPhones must fall back to a 20px status bar inset');
assert(/html\.ipad-device \{[\s\S]*?--safe-bottom: max\(20px, env\(safe-area-inset-bottom, 0px\)\)/.test(styles), 'iPads must fall back to a 20px home-indicator inset');

console.log('iOS standalone layout regression: PASS');
