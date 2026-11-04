'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const playwright = require('playwright');
const root = path.resolve(__dirname, '../public');
async function main() {
    const server = http.createServer((req, res) => {
        const pathname = new URL(req.url, 'http://localhost').pathname;
        const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
        if (!file.startsWith(root + path.sep)) { res.writeHead(404); res.end(); return; }
        res.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[path.extname(file)] || 'application/octet-stream');
        fs.createReadStream(file).on('error', () => { res.writeHead(404); res.end(); }).pipe(res);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await playwright[process.env.RAI_BROWSER_ENGINE || 'chromium'].launch({ headless: true });
    const page = await browser.newPage({ serviceWorkers: 'block' });
    let allowAuth = true;
    const providers = [], activity = [], errors = [], internalBodies = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
        await page.route('**/api/**', async route => {
            const req = route.request(), url = req.url();
            internalBodies.push(req.postData() || '');
            if (url.includes('/user/activity')) activity.push(...(req.postDataJSON()?.events || []));
            await route.fulfill({ status: url.includes('/auth/refresh') || (url.includes('/auth/verify') && !allowAuth) ? 401 : 200,
                contentType: 'application/json', body: JSON.stringify({ success: true, accepted: 50, models: [], announcements: [], sessions: [], data: [] }) });
        });
        await page.route('https://provider.example.invalid/**', async route => {
            const req = route.request();
            if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type' } });
            providers.push(req.postDataJSON());
            const usage = { prompt_tokens: 12000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 4000 },
                cache_write_tokens: 7000, cache_write_30m_tokens: 5000, cache_write_12h_tokens: 2000, total_cost: 0.25, currency: 'USD' };
            await route.fulfill({ contentType: 'text/event-stream', headers: { 'Access-Control-Allow-Origin': '*' }, body:
                'data: ' + JSON.stringify({ choices: [{ delta: { content: 'CUSTOM-ANSWER' }, finish_reason: null }] }) + '\n\n' +
                'data: ' + JSON.stringify({ model: 'custom-test', choices: [], usage }) + '\n\ndata: [DONE]\n\n' });
        });
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        await page.waitForFunction(() => typeof appState !== 'undefined' && appState.authState === 'anonymous');
        await page.evaluate(async () => { await startCustomApiMode(); await sendCustomApiMessage([]); });
        assert.equal(providers.length, 0, 'anonymous custom calls never reach the provider');
        assert.equal(await page.locator('#customApiPanel').isVisible(), false);
        await page.evaluate(() => {
            storeUserAccessToken('fixture-account-a'); appState.user = { id: 'account-a', username: 'Fixture' }; showApp();
            document.getElementById('customApiName').value = '<img src=x onerror=alert(1)>';
            document.getElementById('customApiUrl').value = 'https://provider.example.invalid/v1';
            document.getElementById('customApiKey').value = 'PRIVATE-API-KEY-CANARY';
            document.getElementById('customModelId').value = 'custom-test';
        });
        await page.evaluate(() => startCustomApiMode());
        const saved = await page.evaluate(() => {
            const config = appState.customApiConfigs[0];
            return { id: config?.id, userId: appState.user.id, name: MODELS[config?.id]?.name,
                listed: [...document.querySelectorAll('[data-custom-catalog-model]')].some(item => item.dataset.model === config?.id),
                injected: !!document.querySelector('#customApiList img'), keyInput: document.getElementById('customApiKey').value };
        });
        assert.match(saved.id, /^byok:/); assert.equal(saved.userId, 'account-a');
        assert.equal(saved.listed, true); assert.equal(saved.injected, false); assert.equal(saved.keyInput, '');
        await page.evaluate(id => { enterCustomApiApp(appState.customApiConfigs.find(item => item.id === id)); }, saved.id);
        await page.evaluate(() => sendCustomApiMessage([{ role: 'user', content: 'PRIVATE-PROMPT-CANARY' }]));
        assert.equal(providers.length, 1, 'one user request produces one provider request');
        assert.equal(providers[0].model, 'custom-test'); assert.equal(providers[0].stream_options.include_usage, true);
        assert.equal(await page.evaluate(() => appState.user.id), 'account-a', 'custom API preserves RAI account identity');
        assert.match(await page.evaluate(() => appState.messages.at(-1).content), /CUSTOM-ANSWER/);
        await page.evaluate(() => window.RaiUserActivity.flush());
        const billed = activity.find(event => event.stage === 'custom_api' && event.tokenUsage);
        assert.equal(billed?.tokenUsage.cacheReadTokens, 4000); assert.equal(billed.tokenUsage.cacheWrite12hTokens, 2000);
        assert.equal(billed.tokenUsage.cacheHitRate, 1 / 3); assert.equal(billed.tokenUsage.reportedCost, 0.25);
        assert.equal(billed.tokenUsage.estimatedUsd, null, 'third-party billing is not guessed from an official model price');
        assert.ok(!internalBodies.join('').includes('PRIVATE-API-KEY-CANARY') && !internalBodies.join('').includes('PRIVATE-PROMPT-CANARY'));
        await page.evaluate(() => {
            invalidateUserAuthAsyncWork(); storeUserAccessToken('fixture-account-b'); appState.user = { id: 'account-b' }; loadCustomApiModels();
        });
        assert.equal(await page.evaluate(() => appState.customApiConfigs.length), 0, 'another account cannot read saved API credentials');
        assert.equal(await page.locator(`[data-model="${saved.id}"]`).count(), 0, 'another account cannot select the old custom model');
        await page.evaluate(() => {
            invalidateUserAuthAsyncWork(); storeUserAccessToken('fixture-account-a'); appState.user = { id: 'account-a' }; loadCustomApiModels();
            enterCustomApiApp(appState.customApiConfigs[0]);
        });
        allowAuth = false;
        await page.evaluate(() => sendCustomApiMessage([]));
        assert.equal(providers.length, 1, 'a revoked RAI session blocks a configured custom provider');
        assert.equal(await page.evaluate(() => appState.customApiMode), false);
        assert.deepEqual(errors, []);
        console.log('Custom API account PASS: anonymous/revoked gates, saved model list, RAI identity, account isolation, usage/cost telemetry, key/content privacy and no request replay');
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
