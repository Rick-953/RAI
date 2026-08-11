#!/usr/bin/env node

'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { extractNamedFunction } = require('./beta-static-security-contracts');

const ROOT = path.resolve(__dirname, '..');
const APP_PATH = path.join(ROOT, 'public', 'app.js');
const RAI_TOKEN_KEY = 'rai_beta_token';
const OLD_TOKEN = 'old-session-token';
const NEW_TOKEN = 'new-session-token';
const TWO_FACTOR_ENABLE_TOKEN = 'two-factor-enable-token';
const TWO_FACTOR_DISABLE_TOKEN = 'two-factor-disable-token';

function jsonResponse(status, body) {
    return {
        ok: status >= 200 && status < 300,
        status,
        async json() {
            return body;
        }
    };
}

function buildHarness({ passwordBody, configStatus = 200, configBody = { success: true } }) {
    const source = fs.readFileSync(APP_PATH, 'utf8');
    const elements = new Map([
        ['temperatureSlider', { value: '0.7' }],
        ['topPSlider', { value: '0.9' }],
        ['maxTokensSlider', { value: '2048' }],
        ['frequencySlider', { value: '0' }],
        ['presenceSlider', { value: '0' }],
        ['systemPrompt', { value: 'audit prompt' }],
        ['settingsUsernameInput', { value: 'Audit User' }],
        ['settingsEmailInput', { value: 'audit@example.com' }],
        ['settingsCurrentPasswordInput', { value: 'Current!123', focus() {} }],
        ['settingsNewPasswordInput', { value: 'Next!456', focus() {} }],
        ['settingsConfirmPasswordInput', { value: 'Next!456', focus() {} }]
    ]);
    const storage = new Map([[RAI_TOKEN_KEY, OLD_TOKEN]]);
    const requests = [];
    const toasts = [];
    let dirtyStateUpdates = 0;

    const appState = {
        token: OLD_TOKEN,
        user: { id: 1, email: 'audit@example.com', username: 'Audit User' },
        language: 'en',
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 2048,
        frequencyPenalty: 0,
        presencePenalty: 0,
        systemPrompt: '',
        newChatDefaultMode: 'quick',
        fontPreference: 'rai',
        browserNotifyEnabled: false,
        themePreference: 'light',
        theme: 'light',
        selectedModel: 'auto',
        thinkingMode: false,
        internetMode: false,
        thinkingBudget: 'balanced',
        reasoningProfile: 'balanced',
        researchMode: 'fast',
        researchAgentModels: [],
        researchMasterModel: 'auto',
        researchMaxRounds: 1,
        longMemoryEnabled: false,
        tabTitleMode: 'default',
        tabTitleCustomText: '',
        activeSettingsSection: 'account'
    };

    const context = vm.createContext({
        API_BASE: '/beta/api',
        RAI_TOKEN_KEY,
        appState,
        console: { log() {}, error() {}, warn() {} },
        document: { getElementById: (id) => elements.get(id) || null },
        localStorage: {
            getItem: (key) => storage.get(key) || null,
            setItem: (key, value) => storage.set(key, String(value))
        },
        fetch: async (url, options = {}) => {
            requests.push({ url, options });
            if (url === '/beta/api/user/password') return jsonResponse(200, passwordBody);
            if (url === '/beta/api/user/config') return jsonResponse(configStatus, configBody);
            throw new Error(`unexpected request: ${url}`);
        },
        i18nText: (_key, fallback) => fallback,
        isChineseLanguage: () => false,
        showToast: (message) => toasts.push(message),
        persistLocalSettingsPatch() {},
        getCapabilityPreferencesPatch: () => ({}),
        setSettingsSaveButtonState() {},
        normalizeThinkingBudget: (value) => value,
        normalizeReasoningProfile: (value) => value,
        isResearchModeEnabled: () => false,
        normalizeResearchMode: (value) => value,
        normalizeResearchAgentModels: (value) => value,
        normalizeResearchMasterModel: (value) => value,
        normalizeResearchMaxRounds: (value) => value,
        updateUserIdentityUI() {},
        updateSettingsUI() {},
        closeSettings() {},
        switchSettingsSection() {},
        updateSettingsDirtyState: () => { dirtyStateUpdates += 1; }
    });

    vm.runInContext([
        extractNamedFunction(source, 'requireAndStoreRotatedUserSessionToken'),
        extractNamedFunction(source, 'clearSettingsPasswordInputs'),
        extractNamedFunction(source, 'saveSettings'),
        'globalThis.__saveSettings = saveSettings;'
    ].join('\n\n'), context, { filename: APP_PATH });

    return {
        appState,
        elements,
        storage,
        requests,
        toasts,
        get dirtyStateUpdates() { return dirtyStateUpdates; },
        saveSettings: context.__saveSettings
    };
}

function buildTwoFactorHarness({ enableBody, disableBody }) {
    const source = fs.readFileSync(APP_PATH, 'utf8');
    const elements = new Map([
        ['settingsTwoFactorEnableCode', { value: '123456' }],
        ['settingsTwoFactorDisableCode', { value: '654321' }]
    ]);
    const storage = new Map([[RAI_TOKEN_KEY, OLD_TOKEN]]);
    const requests = [];
    const toasts = [];
    let renderCount = 0;
    const appState = {
        token: OLD_TOKEN,
        user: { id: 1, email: 'audit@example.com', two_factor_enabled: false, twoFactorEnabled: false },
        twoFactorSetup: { setupToken: 'setup-token' }
    };

    const context = vm.createContext({
        API_BASE: '/beta/api',
        RAI_TOKEN_KEY,
        appState,
        console: { log() {}, error() {}, warn() {} },
        document: { getElementById: (id) => elements.get(id) || null },
        localStorage: {
            getItem: (key) => storage.get(key) || null,
            setItem: (key, value) => storage.set(key, String(value))
        },
        fetch: async (url, options = {}) => {
            requests.push({ url, options });
            if (url === '/beta/api/user/2fa/enable') return jsonResponse(200, enableBody);
            if (url === '/beta/api/user/2fa/disable') return jsonResponse(200, disableBody);
            if (url === '/beta/api/auth/verify') {
                return options.headers?.Authorization === `Bearer ${appState.token}`
                    ? jsonResponse(200, { success: true })
                    : jsonResponse(403, { success: false });
            }
            throw new Error(`unexpected request: ${url}`);
        },
        normalizeTwoFactorCode: (value) => String(value || '').replace(/\D/g, '').slice(0, 6),
        i18nText: (_key, fallback) => fallback,
        showToast: (message) => toasts.push(message),
        localizeServerError: (message) => message,
        renderTwoFactorSettings: () => { renderCount += 1; }
    });

    vm.runInContext([
        extractNamedFunction(source, 'getTwoFactorAuthHeaders'),
        extractNamedFunction(source, 'requireAndStoreRotatedUserSessionToken'),
        extractNamedFunction(source, 'confirmTwoFactorSetup'),
        extractNamedFunction(source, 'disableTwoFactor'),
        'globalThis.__confirmTwoFactorSetup = confirmTwoFactorSetup;',
        'globalThis.__disableTwoFactor = disableTwoFactor;',
        'globalThis.__getTwoFactorAuthHeaders = getTwoFactorAuthHeaders;',
        'globalThis.__probeAuthenticatedRequest = () => fetch(`${API_BASE}/auth/verify`, { headers: getTwoFactorAuthHeaders() });'
    ].join('\n\n'), context, { filename: APP_PATH });

    return {
        appState,
        storage,
        requests,
        toasts,
        get renderCount() { return renderCount; },
        confirmTwoFactorSetup: context.__confirmTwoFactorSetup,
        disableTwoFactor: context.__disableTwoFactor,
        getTwoFactorAuthHeaders: context.__getTwoFactorAuthHeaders,
        probeAuthenticatedRequest: context.__probeAuthenticatedRequest
    };
}

function assertPasswordInputsCleared(harness) {
    for (const id of ['settingsCurrentPasswordInput', 'settingsNewPasswordInput', 'settingsConfirmPasswordInput']) {
        assert.equal(harness.elements.get(id).value, '', `${id} must be cleared`);
    }
}

async function testSuccessfulContinuation() {
    const harness = buildHarness({ passwordBody: { success: true, token: NEW_TOKEN } });
    await harness.saveSettings();

    assert.equal(harness.appState.token, NEW_TOKEN, 'app state must retain the rotated token');
    assert.equal(harness.storage.get(RAI_TOKEN_KEY), NEW_TOKEN, 'Beta-scoped token storage must retain the rotated token');
    assert.equal(harness.requests.length, 2, 'password save must continue into config sync');
    assert.equal(harness.requests[1].url, '/beta/api/user/config');
    assert.equal(harness.requests[1].options.headers.Authorization, `Bearer ${NEW_TOKEN}`, 'config sync must use the rotated token');
    assertPasswordInputsCleared(harness);
}

async function testPartialFailureCleanup() {
    const harness = buildHarness({
        passwordBody: { success: true, token: NEW_TOKEN },
        configStatus: 403,
        configBody: { success: false, error: 'config rejected' }
    });
    await harness.saveSettings();

    assert.equal(harness.requests[1].options.headers.Authorization, `Bearer ${NEW_TOKEN}`, 'even a failing config request must use the rotated token');
    assert.equal(harness.appState.token, NEW_TOKEN);
    assert.equal(harness.storage.get(RAI_TOKEN_KEY), NEW_TOKEN);
    assertPasswordInputsCleared(harness);
    assert.ok(harness.dirtyStateUpdates >= 1, 'partial failure cleanup must refresh dirty state');
    assert.ok(harness.toasts.includes('Part of your changes were saved, but config sync failed'));
}

async function testMissingReplacementTokenStopsOldSessionReuse() {
    const harness = buildHarness({ passwordBody: { success: true } });
    await harness.saveSettings();

    assert.equal(harness.requests.length, 1, 'missing replacement token must stop before config sync');
    assert.equal(harness.appState.token, OLD_TOKEN, 'an absent replacement token must not overwrite state');
    assert.equal(harness.storage.get(RAI_TOKEN_KEY), OLD_TOKEN, 'an absent replacement token must not overwrite storage');
    assertPasswordInputsCleared(harness);
    assert.ok(harness.toasts.includes('Part of your changes were saved, but config sync failed'));
}

async function testTwoFactorEnableDisableTokenContinuation() {
    const harness = buildTwoFactorHarness({
        enableBody: { success: true, token: TWO_FACTOR_ENABLE_TOKEN, two_factor_enabled: true },
        disableBody: { success: true, token: TWO_FACTOR_DISABLE_TOKEN, two_factor_enabled: false }
    });

    await harness.confirmTwoFactorSetup();
    assert.equal(harness.requests[0].options.headers.Authorization, `Bearer ${OLD_TOKEN}`);
    assert.equal(harness.appState.token, TWO_FACTOR_ENABLE_TOKEN);
    assert.equal(harness.storage.get(RAI_TOKEN_KEY), TWO_FACTOR_ENABLE_TOKEN);
    assert.equal(harness.appState.user.two_factor_enabled, true);

    await harness.disableTwoFactor();
    assert.equal(harness.requests[1].options.headers.Authorization, `Bearer ${TWO_FACTOR_ENABLE_TOKEN}`, '2FA disable must use the token returned by enable');
    assert.equal(harness.appState.token, TWO_FACTOR_DISABLE_TOKEN);
    assert.equal(harness.storage.get(RAI_TOKEN_KEY), TWO_FACTOR_DISABLE_TOKEN);
    assert.equal(harness.appState.user.two_factor_enabled, false);
    assert.equal(harness.getTwoFactorAuthHeaders().Authorization, `Bearer ${TWO_FACTOR_DISABLE_TOKEN}`, 'subsequent authenticated requests must use the disable token');
    const probe = await harness.probeAuthenticatedRequest();
    assert.equal(probe.status, 200, 'a subsequent authenticated request must remain usable');
    assert.equal(harness.renderCount, 2, 'each committed 2FA transition must render exactly once');
}

async function testTwoFactorEnableMissingTokenFailsBeforeUiUpdate() {
    const harness = buildTwoFactorHarness({
        enableBody: { success: true, two_factor_enabled: true },
        disableBody: { success: true, token: TWO_FACTOR_DISABLE_TOKEN }
    });

    await harness.confirmTwoFactorSetup();
    assert.equal(harness.appState.token, OLD_TOKEN);
    assert.equal(harness.storage.get(RAI_TOKEN_KEY), OLD_TOKEN);
    assert.equal(harness.appState.user.two_factor_enabled, false, 'missing enable token must not claim 2FA is enabled');
    assert.ok(harness.appState.twoFactorSetup, 'missing enable token must retain setup state for recovery');
    assert.equal(harness.renderCount, 0, 'missing enable token must not update the 2FA UI');
    assert.ok(harness.toasts.includes('二步验证已开启，但会话刷新失败，请重新登录'));
}

async function testTwoFactorDisableMissingTokenFailsBeforeUiUpdate() {
    const harness = buildTwoFactorHarness({
        enableBody: { success: true, token: TWO_FACTOR_ENABLE_TOKEN, two_factor_enabled: true },
        disableBody: { success: true, two_factor_enabled: false }
    });

    await harness.confirmTwoFactorSetup();
    await harness.disableTwoFactor();
    assert.equal(harness.appState.token, TWO_FACTOR_ENABLE_TOKEN);
    assert.equal(harness.storage.get(RAI_TOKEN_KEY), TWO_FACTOR_ENABLE_TOKEN);
    assert.equal(harness.appState.user.two_factor_enabled, true, 'missing disable token must not claim 2FA is disabled');
    assert.equal(harness.renderCount, 1, 'missing disable token must not render a second state transition');
    assert.ok(harness.toasts.includes('二步验证已关闭，但会话刷新失败，请重新登录'));
}

async function main() {
    assert.ok(ROOT.endsWith(`${path.sep}beta版本`), `refusing unexpected project root: ${ROOT}`);
    await testSuccessfulContinuation();
    await testPartialFailureCleanup();
    await testMissingReplacementTokenStopsOldSessionReuse();
    await testTwoFactorEnableDisableTokenContinuation();
    await testTwoFactorEnableMissingTokenFailsBeforeUiUpdate();
    await testTwoFactorDisableMissingTokenFailsBeforeUiUpdate();
    console.log('beta-settings-password-token-regression ok (6/6)');
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`beta-settings-password-token-regression failed: ${error.stack || error.message}`);
        process.exitCode = 1;
    });
}

module.exports = {
    buildHarness,
    testSuccessfulContinuation,
    testPartialFailureCleanup,
    testMissingReplacementTokenStopsOldSessionReuse,
    testTwoFactorEnableDisableTokenContinuation,
    testTwoFactorEnableMissingTokenFailsBeforeUiUpdate,
    testTwoFactorDisableMissingTokenFailsBeforeUiUpdate
};
