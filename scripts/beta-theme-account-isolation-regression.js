#!/usr/bin/env node

'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { extractNamedFunction } = require('./beta-static-security-contracts');

const ROOT = path.resolve(__dirname, '..');
const APP_PATH = path.join(ROOT, 'public', 'app.js');
const RAI_THEME_KEY = 'rai_beta_theme';

function buildThemeHarness({ systemTheme = 'light' } = {}) {
    const source = fs.readFileSync(APP_PATH, 'utf8');
    const storage = new Map();
    const rootAttributes = new Map();
    let optionRefreshes = 0;
    const appState = { theme: 'dark', themePreference: 'dark' };

    const context = vm.createContext({
        RAI_THEME_KEY,
        appState,
        window: {
            matchMedia: () => ({ matches: systemTheme === 'light' })
        },
        document: {
            documentElement: {
                setAttribute: (name, value) => rootAttributes.set(name, String(value))
            },
            getElementById: () => null,
            querySelector: () => null
        },
        localStorage: {
            getItem: (key) => storage.get(key) ?? null,
            setItem: (key, value) => storage.set(key, String(value))
        },
        getSvgIcon: () => '',
        updateSettingsOptionButtons: () => { optionRefreshes += 1; }
    });

    vm.runInContext([
        extractNamedFunction(source, 'getSystemTheme'),
        extractNamedFunction(source, 'getEffectiveTheme'),
        extractNamedFunction(source, 'setTheme'),
        extractNamedFunction(source, 'applyAuthenticatedThemePreference'),
        'globalThis.__setTheme = setTheme;',
        'globalThis.__applyAuthenticatedThemePreference = applyAuthenticatedThemePreference;'
    ].join('\n\n'), context, { filename: APP_PATH });

    return {
        appState,
        storage,
        rootAttributes,
        get optionRefreshes() { return optionRefreshes; },
        setTheme: context.__setTheme,
        applyAuthenticatedThemePreference: context.__applyAuthenticatedThemePreference
    };
}

function assertThemeState(harness, { preference, effective }) {
    assert.equal(harness.appState.themePreference, preference);
    assert.equal(harness.appState.theme, effective);
    assert.equal(harness.rootAttributes.get('data-theme-preference'), preference);
    assert.equal(harness.rootAttributes.get('data-theme'), effective);
    assert.equal(harness.storage.get(RAI_THEME_KEY), preference);
}

function testAuthenticatedAccountSwitchOverridesPreviousTheme() {
    const harness = buildThemeHarness();

    // Account B was the last account in this browser and left the early/offline
    // fallback on light. Account A's server profile is authoritative on login.
    harness.storage.set(RAI_THEME_KEY, 'light');
    harness.setTheme(harness.storage.get(RAI_THEME_KEY));
    assertThemeState(harness, { preference: 'light', effective: 'light' });

    harness.applyAuthenticatedThemePreference('dark');
    assertThemeState(harness, { preference: 'dark', effective: 'dark' });

    // Switching back to B must likewise use B's server profile, not A's dark
    // fallback that now occupies the same browser key.
    harness.applyAuthenticatedThemePreference('light');
    assertThemeState(harness, { preference: 'light', effective: 'light' });
    assert.equal(harness.optionRefreshes, 3);
}

function testSystemAndInvalidServerThemeNormalization() {
    const harness = buildThemeHarness({ systemTheme: 'light' });
    harness.applyAuthenticatedThemePreference(' SYSTEM ');
    assertThemeState(harness, { preference: 'system', effective: 'light' });

    harness.applyAuthenticatedThemePreference('attacker-controlled-theme');
    assertThemeState(harness, { preference: 'dark', effective: 'dark' });
}

function testLoadingOrderContracts() {
    const source = fs.readFileSync(APP_PATH, 'utf8');
    const loadUserData = extractNamedFunction(source, 'loadUserData');
    const profileRead = loadUserData.indexOf('const profile = await profileResponse.json()');
    const serverThemeApply = loadUserData.indexOf('applyAuthenticatedThemePreference(profile.theme)');
    const accountFontApply = loadUserData.indexOf('applyFontPreference(profile.font_preference');
    assert.ok(profileRead >= 0, 'loadUserData must read the authenticated profile');
    assert.ok(serverThemeApply > profileRead, 'server theme must apply after the authenticated profile arrives');
    assert.ok(accountFontApply > serverThemeApply, 'theme and font must both come from the same authenticated profile pass');

    const verifyToken = extractNamedFunction(source, 'verifyToken');
    const enterAuthenticatedApp = extractNamedFunction(source, 'enterAuthenticatedApp');
    assert.match(verifyToken, /await\s+loadUserData\s*\(\s*\)/, 'session restoration must load the server theme');
    assert.match(enterAuthenticatedApp, /await\s+loadUserData\s*\(\s*\)/, 'fresh login must load the server theme');

    const initThemeAndLanguage = extractNamedFunction(source, 'initThemeAndLanguage');
    assert.match(
        initThemeAndLanguage,
        /localStorage\.getItem\(RAI_THEME_KEY\)\s*\|\|\s*['"]dark['"]/,
        'offline and unauthenticated startup must keep using the browser theme fallback'
    );
    assert.match(initThemeAndLanguage, /setTheme\(savedTheme\)/, 'startup fallback must still be applied');

    const loadSettings = extractNamedFunction(source, 'loadSettings');
    assert.doesNotMatch(loadSettings, /RAI_THEME_KEY|setTheme\s*\(/, 'account-local settings must not overwrite the server theme later in the load sequence');
}

function main() {
    assert.ok(ROOT.endsWith(`${path.sep}beta版本`), `refusing unexpected project root: ${ROOT}`);
    testAuthenticatedAccountSwitchOverridesPreviousTheme();
    testSystemAndInvalidServerThemeNormalization();
    testLoadingOrderContracts();
    console.log('beta-theme-account-isolation-regression ok (3/3)');
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(`beta-theme-account-isolation-regression failed: ${error.stack || error.message}`);
        process.exitCode = 1;
    }
}

module.exports = {
    buildThemeHarness,
    testAuthenticatedAccountSwitchOverridesPreviousTheme,
    testSystemAndInvalidServerThemeNormalization,
    testLoadingOrderContracts
};
