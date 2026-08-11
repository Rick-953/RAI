#!/usr/bin/env node

'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { auditRoutes } = require('./beta-route-contract-audit');

const ROOT = path.resolve(__dirname, '..');
const SERVER_PATH = path.join(ROOT, 'server.js');
const APP_PATH = path.join(ROOT, 'public', 'app.js');
const TOKEN_PATH = path.join(ROOT, 'user-session-token.js');
const SW_PATH = path.join(ROOT, 'public', 'sw.js');
const INDEX_PATH = path.join(ROOT, 'public', 'index.html');
const MANIFEST_PATH = path.join(ROOT, 'public', 'site.webmanifest');
const STYLES_PATH = path.join(ROOT, 'public', 'styles.css');

function findBalancedEnd(source, openIndex, openChar = '{', closeChar = '}') {
    let depth = 0;
    let quote = '';
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    for (let index = openIndex; index < source.length; index += 1) {
        const char = source[index];
        const next = source[index + 1] || '';
        if (lineComment) {
            if (char === '\n') lineComment = false;
            continue;
        }
        if (blockComment) {
            if (char === '*' && next === '/') {
                blockComment = false;
                index += 1;
            }
            continue;
        }
        if (quote) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === quote) quote = '';
            continue;
        }
        if (char === '/' && next === '/') {
            lineComment = true;
            index += 1;
            continue;
        }
        if (char === '/' && next === '*') {
            blockComment = true;
            index += 1;
            continue;
        }
        if (char === '\'' || char === '"' || char === '`') {
            quote = char;
            continue;
        }
        if (char === openChar) depth += 1;
        if (char === closeChar) {
            depth -= 1;
            if (depth === 0) return index;
        }
    }
    throw new Error(`unbalanced ${openChar}${closeChar} block at ${openIndex}`);
}

function extractNamedFunction(source, name) {
    const patterns = [
        new RegExp(`async\\s+function\\s+${name}\\s*\\(`),
        new RegExp(`function\\s+${name}\\s*\\(`),
        new RegExp(`const\\s+${name}\\s*=\\s*async\\s*\\(`),
        new RegExp(`const\\s+${name}\\s*=\\s*\\(`)
    ];
    const match = patterns.map((pattern) => pattern.exec(source)).find(Boolean);
    assert.ok(match, `function ${name} must exist`);
    // Do not treat a destructured parameter's "{" as the function body. First
    // balance the complete parameter list, then locate the block after its ")".
    const parameterOpen = source.indexOf('(', match.index);
    assert.ok(parameterOpen >= 0, `function ${name} must have a parameter list`);
    const parameterClose = findBalancedEnd(source, parameterOpen, '(', ')');
    const open = source.indexOf('{', parameterClose + 1);
    assert.ok(open >= 0, `function ${name} must have a block body`);
    return source.slice(match.index, findBalancedEnd(source, open) + 1);
}

function collectRawInterpolations(source, patterns) {
    const hits = [];
    for (const item of patterns) {
        const regex = new RegExp(item.regex.source, item.regex.flags.includes('g') ? item.regex.flags : `${item.regex.flags}g`);
        let match;
        while ((match = regex.exec(source))) {
            hits.push({
                label: item.label,
                line: source.slice(0, match.index).split('\n').length,
                sample: match[0]
            });
        }
    }
    return hits;
}

function checkTokenPurpose(serverSource, tokenSource, routeSummary) {
    const verifier = extractNamedFunction(serverSource, 'verifyAuthenticatedUserSession');
    assert.match(verifier, /verifyUserSessionToken\s*\(/, 'central DB-aware verifier must validate token purpose');

    const middleware = extractNamedFunction(serverSource, 'authenticateToken');
    assert.match(middleware, /verifyAuthenticatedUserSession\s*\(/, 'Bearer middleware must use central DB-aware verifier');

    const streamRoute = routeSummary.routes.find((route) => route.key === 'GET /api/sessions/:id/stream-events');
    assert.ok(streamRoute, 'stream-events route must exist');
    const fullRoute = routeSummary._fullRoutes?.find((route) => route.key === streamRoute.key);
    const streamSource = fullRoute?.callSource || serverSource.slice(
        serverSource.indexOf("app.get('/api/sessions/:id/stream-events'"),
        serverSource.indexOf("app.get('/api/sessions/:id/stream-events'") + 5000
    );
    assert.match(streamSource, /verifyAuthenticatedUserSession\s*\(/, 'stream-events must reject challenge/admin token types through the central verifier');

    assert.match(tokenSource, /USER_SESSION_TOKEN_TYPE\s*=\s*['"]user_session['"]/, 'normal sessions must carry user_session purpose');
    assert.match(tokenSource, /tokenType\s*===\s*undefined/, 'legacy untyped normal sessions must remain compatible');
    assert.match(tokenSource, /tokenType\s*===\s*USER_SESSION_TOKEN_TYPE/, 'only user_session typed tokens may authenticate');

    const twoFactorBuilder = extractNamedFunction(serverSource, 'buildUserLoginTwoFactorToken');
    assert.match(twoFactorBuilder, /authVersion/, '2FA login challenge must capture auth_version');
    const twoFactorRoute = routeSummary._fullRoutes?.find((route) => route.key === 'POST /api/auth/login/2fa');
    assert.ok(twoFactorRoute, '2FA login route must exist');
    assert.match(twoFactorRoute.callSource, /decoded\.authVersion[\s\S]*user\.auth_version/, '2FA login must compare challenge auth_version to current user state');
    assert.match(twoFactorRoute.callSource, /decoded\.email[\s\S]*user\.email/, '2FA login challenge must remain bound to current email identity');
}

function checkTransactions(serverSource) {
    const legacyBegins = [...serverSource.matchAll(/dbRunAsync\(\s*['"`]BEGIN IMMEDIATE(?: TRANSACTION)?['"`]/g)];
    assert.equal(
        legacyBegins.length,
        0,
        `all ${legacyBegins.length} global-connection BEGIN IMMEDIATE sites must move to dedicated-connection transaction helper`
    );
    assert.match(serverSource, /withImmediateTransaction|withDedicatedTransaction/, 'a dedicated SQLite transaction helper must exist');

    const verifier = extractNamedFunction(serverSource, 'verifyAndConsumeEmailCode');
    assert.match(verifier, /UPDATE\s+auth_email_codes[\s\S]*consumed_at\s+IS\s+NULL/i, 'email code consumption must be conditional');
    assert.match(verifier, /changes[\s\S]*(?:!==|===|!=|==)\s*1|Number\([^)]*changes[^)]*\)[\s\S]*1/, 'email code consumption must require exactly one changed row');
    assert.match(verifier, /withImmediateTransaction|withDedicatedTransaction/, 'email code verification and consumption must share one transaction');
}

function checkAttachmentContracts(serverSource) {
    const sanitizer = extractNamedFunction(serverSource, 'sanitizeClientAttachment');
    assert.match(sanitizer, /['"]text['"]/, 'client attachment sanitizer must accept text attachments');
    assert.match(sanitizer, /['"]code['"]/, 'client attachment sanitizer must accept code attachments');
    for (const field of ['fileId', 'filename', 'filePath', 'mimeType', 'size']) {
        assert.match(sanitizer, new RegExp(`\\b${field}\\s*:`), `sanitizer must retain ${field}`);
    }

    const storageSignals = (serverSource.match(/\b(?:fileId|filename|filePath|mimeType|fileType|size)\s*:/g) || []).length;
    assert.ok(storageSignals >= 12, 'attachment metadata must be retained beyond the input sanitizer and upload response');
    assert.match(serverSource, /app\.delete\(\s*['"]\/api\/uploads\/:filename['"]/, 'owner-only upload deletion endpoint must exist');
}

function checkOfficeIsolation(serverSource) {
    const supportingFiles = fs.readdirSync(ROOT)
        .filter((name) => /office|extract/i.test(name) && name.endsWith('.js'))
        .map((name) => fs.readFileSync(path.join(ROOT, name), 'utf8'));
    const officeSource = [serverSource, ...supportingFiles].join('\n');
    assert.doesNotMatch(officeSource, /\b(?:execSync|spawnSync)\s*\(/, 'Office extraction must never use synchronous child-process execution');
    assert.doesNotMatch(officeSource, /(?<![.\w$])exec\s*\(/, 'Office extraction must not call a child-process exec binding');
    assert.doesNotMatch(officeSource, /require\(\s*['"]child_process['"]\s*\)\s*\.\s*exec\s*\(/, 'Office extraction must not call child_process.exec');
    assert.doesNotMatch(officeSource, /\{[^}]*\bexec\b[^}]*\}\s*=\s*require\(\s*['"]child_process['"]\s*\)/, 'Office extraction must not import child_process.exec');
    assert.doesNotMatch(officeSource, /\bshell\s*:\s*true\b/, 'Office extraction must never opt into a shell');
    assert.doesNotMatch(
        officeSource,
        /\b(?:spawn|execFile)\s*\(\s*['"](?:\/bin\/)?(?:sh|bash)['"]\s*,\s*\[[^\]]*['"]-c['"]/,
        'Office extraction must not invoke sh/bash -c indirectly'
    );
    assert.match(officeSource, /\b(?:execFile|fork|spawn)\s*\(/, 'Office parsing must run in an isolated child process');
    assert.match(officeSource, /mkdtemp|randomUUID|randomBytes/, 'Office parsing must use collision-resistant temporary paths');
    assert.match(officeSource, /timeout|AbortController/i, 'Office parsing must have a hard timeout');
    assert.match(officeSource, /max(?:imum)?[_A-Za-z]*(?:bytes|entries|output|uncompressed)|MAX_[A-Z_]*(?:BYTES|ENTRIES|OUTPUT)/i, 'Office parser must enforce archive/output bounds');
    assert.match(officeSource, /finally[\s\S]*(?:rm|unlink)/, 'Office temporary files must be cleaned in finally');
}

function checkXssContracts(appSource) {
    const hits = collectRawInterpolations(appSource, [
        { label: 'attachment filename in HTML', regex: /\$\{\s*currentAttachment\.fileName\s*\}/ },
        { label: 'space name in HTML', regex: /\$\{\s*space\.name\s*\}/ },
        { label: 'space icon in HTML', regex: /\$\{\s*space\.icon\s*\}/ },
        { label: 'document original_name in HTML', regex: /\$\{\s*doc\.original_name\s*\}/ },
        { label: 'flow name/title in HTML', regex: /\$\{\s*flow\.(?:name|title)\s*\}/ },
        { label: 'uploaded file name in HTML', regex: /\$\{\s*(?:file|upload)\.(?:name|originalName|original_name)\s*\}/ }
    ]);
    assert.deepEqual(hits, [], `unescaped user-controlled DOM interpolation remains: ${JSON.stringify(hits)}`);
    assert.match(appSource, /function\s+escapeHtml\s*\(/, 'frontend must retain a central HTML escaping helper');
    assert.match(appSource, /DOMPurify|sanitizeRenderedHtml/, 'rendered rich content must pass a sanitizer');
}

function checkBetaIsolationContracts(appSource) {
    const swSource = fs.readFileSync(SW_PATH, 'utf8');
    const indexSource = fs.readFileSync(INDEX_PATH, 'utf8');
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));

    assert.match(swSource, /RAI_BETA_SCOPE_PATH\s*=\s*['"]\/beta\/['"]/, 'service worker scope constant must be /beta/');
    for (const prefix of ['rai-static-beta-', 'rai-avatar-beta-', 'rai-fonts-beta-']) {
        assert.ok(swSource.includes(prefix), `service worker must use ${prefix}`);
    }
    assert.doesNotMatch(swSource, /rai-(?:static|avatar|fonts)-root-/, 'Beta worker must not touch formal root caches');

    const assetArrayMatch = swSource.match(/const\s+RAI_STATIC_ASSETS\s*=\s*\[([\s\S]*?)\];/);
    assert.ok(assetArrayMatch, 'service worker static asset list must exist');
    const assetStrings = [...assetArrayMatch[1].matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]);
    assert.ok(assetStrings.length > 0, 'service worker static asset list must not be empty');
    assert.ok(assetStrings.every((asset) => asset === '/beta/' || asset.startsWith('/beta/')), 'every Beta precache URL must stay under /beta/');

    const installStart = swSource.indexOf("self.addEventListener('install'");
    const activateStart = swSource.indexOf("self.addEventListener('activate'");
    assert.ok(installStart >= 0 && activateStart > installStart, 'service worker install/activate handlers must exist');
    const installSource = swSource.slice(installStart, activateStart);
    assert.match(installSource, /await\s+cache\.addAll\s*\(/, 'precache must await addAll');
    assert.match(installSource, /catch\s*\([^)]*\)[\s\S]*caches\.delete\s*\(\s*RAI_CACHE_NAME\s*\)[\s\S]*throw\s+\w+/, 'install failure must delete incomplete cache and rethrow');

    assert.ok(String(manifest.start_url || '').startsWith('/beta/'), 'Beta manifest start_url must stay under /beta/');
    assert.equal(manifest.scope, '/beta/', 'Beta manifest scope must be /beta/');
    assert.match(indexSource, /\/beta\/site\.webmanifest/, 'Beta HTML must load the /beta manifest');
    assert.match(appSource, /serviceWorker\.register\s*\([\s\S]*RAI_BETA_BASE_PATH[\s\S]*\/sw\.js[\s\S]*scope\s*:/, 'Beta frontend must register /beta/sw.js with explicit scope');

    assert.match(appSource, /RAI_BETA_BASE_PATH\s*=\s*['"]\/beta['"]/, 'frontend Beta base path must be explicit');
    assert.match(appSource, /typeof\s+resource\s*===\s*['"]string['"][\s\S]*resolveRaiWebBetaPath/, 'string fetch targets must be rewritten through Beta resolver');
    assert.match(appSource, /resource\s+instanceof\s+Request[\s\S]*new\s+Request\s*\(\s*nextUrl/, 'Request objects must be reconstructed with the Beta URL');

    for (const key of [
        'rai_beta_token',
        'rai_beta_settings',
        'rai_beta_theme',
        'rai_beta_language',
        'rai_beta_chatflow_patch_apply_mode'
    ]) {
        assert.ok(appSource.includes(`'${key}'`) || appSource.includes(`"${key}"`), `missing isolated storage key ${key}`);
    }

    const verifyToken = extractNamedFunction(appSource, 'verifyToken');
    assert.match(verifyToken, /parseApiJsonResponse\s*\(/, 'verifyToken must use the guarded API JSON parser');
    assert.match(verifyToken, /response\.status\s*===\s*401\s*\|\|\s*response\.status\s*===\s*403/, 'verifyToken may invalidate auth only on explicit 401/403');
    const tokenRemovals = verifyToken.match(/localStorage\.removeItem\(RAI_TOKEN_KEY\)/g) || [];
    assert.equal(tokenRemovals.length, 1, 'verifyToken must have exactly one token-clear site');
    const catchIndex = verifyToken.indexOf('catch');
    const removalIndex = verifyToken.indexOf('localStorage.removeItem(RAI_TOKEN_KEY)');
    assert.ok(removalIndex >= 0 && (catchIndex < 0 || removalIndex < catchIndex), 'verifyToken network catch must never clear a valid token');

    const unavailableState = extractNamedFunction(appSource, 'showAuthUnavailableState');
    assert.match(unavailableState, /showAuthScreen\s*\(\s*\{\s*sessionUnavailable\s*:\s*true\s*\}\s*\)/, 'transient verification failures must use the unavailable state');
    assert.match(unavailableState, /auth-session-unavailable/, 'transient verification state must isolate the sign-in form');
    assert.match(unavailableState, /authSessionRetryBtn[\s\S]*disabled\s*=\s*false/, 'transient verification state must expose a retry action');
    assert.match(unavailableState, /panel\.hidden\s*=\s*false/, 'transient verification panel must be visible');
    const stylesSource = fs.readFileSync(STYLES_PATH, 'utf8');
    assert.match(stylesSource, /\.auth-session-unavailable\s+\.auth-form\s*,[\s\S]*\.auth-session-unavailable\s+\.auth-footer\s*\{[\s\S]*display\s*:\s*none/, 'transient verification state must hide the login form/footer');

    const refresh = extractNamedFunction(appSource, 'refreshToLatestAppVersion');
    assert.doesNotMatch(refresh, /Promise\.all\s*\(\s*keys\.map\s*\([^)]*caches\.delete/, 'Beta refresh must never delete every same-origin cache');
    assert.match(refresh, /keys\.filter\s*\(/, 'Beta refresh cache cleanup must filter cache names before deletion');
    assert.match(refresh, /rai-(?:static|avatar|fonts)-beta-|RAI_BETA_CACHE_(?:PREFIX|PREFIXES)|isRaiBetaCache/i, 'Beta refresh cache filter must be explicitly scoped to Beta prefixes');
}

function checkComposerAttachmentLifecycle(appSource) {
    const deletion = extractNamedFunction(appSource, 'deleteUnsentComposerAttachment');
    assert.match(deletion, /fetch\s*\(\s*`\$\{API_BASE\}\/uploads\/\$\{encodeURIComponent\(filename\)\}`/, 'unsent attachment cleanup must target the owner DELETE endpoint');
    assert.match(deletion, /method\s*:\s*['"]DELETE['"]/, 'unsent attachment cleanup must use DELETE');
    assert.match(deletion, /pendingComposerAttachmentCleanup\.delete\s*\(\s*filename\s*\)/, 'successful cleanup must clear retry state');
    assert.match(deletion, /cleanupFailed\s*=\s*true[\s\S]*pendingComposerAttachmentCleanup\.set\s*\(\s*filename/, 'failed cleanup must retain attachment and enqueue retry state');
    assert.match(deletion, /catch\s*\([^)]*\)[\s\S]*return\s+false/, 'failed cleanup must report failure to its caller');

    const removal = extractNamedFunction(appSource, 'removeAttachment');
    assert.match(removal, /if\s*\(\s*!removed\s*\)[\s\S]*return/, 'composer removal must keep the current attachment when server cleanup fails');
    assert.match(removal, /if\s*\(\s*currentAttachment\s*===\s*attachment\s*\)\s*currentAttachment\s*=\s*null/, 'composer removal may clear current attachment only after successful cleanup');

    const upload = extractNamedFunction(appSource, 'processUploadedFile');
    const replacementAssigned = upload.indexOf('currentAttachment = uploadedAttachment');
    const replacementDeleted = upload.indexOf('deleteUnsentComposerAttachment(replacedAttachment)');
    assert.ok(replacementAssigned >= 0 && replacementDeleted > replacementAssigned, 'replacement cleanup must run only after the new upload is accepted');

    const sendMessage = extractNamedFunction(appSource, 'sendMessage');
    assert.match(sendMessage, /pendingComposerAttachmentCleanup\.delete\s*\(\s*sentFilename\s*\)/, 'sending must remove the sent filename from pending cleanup');
    assert.doesNotMatch(sendMessage, /deleteUnsentComposerAttachment\s*\(\s*currentAttachment\s*\)/, 'sending must never delete an attachment that is now message-owned');
}

function checkFrontendMessageDeleteSeparation(appSource) {
    const chatDefinitions = appSource.match(/async\s+function\s+deleteChatMessage\s*\(/g) || [];
    const adminDefinitions = appSource.match(/async\s+function\s+deleteAdminMessage\s*\(/g) || [];
    assert.equal(chatDefinitions.length, 1, 'chat delete handler must have exactly one definition');
    assert.equal(adminDefinitions.length, 1, 'admin delete handler must have exactly one definition');
    assert.doesNotMatch(appSource, /(?:async\s+)?function\s+deleteMessage\s*\(/, 'ambiguous deleteMessage handler must not be reintroduced');
    assert.match(appSource, /deleteBtn\.addEventListener\(\s*['"]click['"]\s*,\s*\(\)\s*=>\s*deleteChatMessage\(message\)\s*\)/, 'chat message buttons must call deleteChatMessage(message)');
    assert.match(appSource, /onclick=['"]deleteAdminMessage\(\$\{messageId\}\)['"]/, 'admin message table must call deleteAdminMessage(messageId)');

    const chatDelete = extractNamedFunction(appSource, 'deleteChatMessage');
    assert.match(chatDelete, /deleteMessageFromDB\s*\(\s*message\s*\)/, 'chat handler must use the user-session delete helper');
    const userDeleteRequest = extractNamedFunction(appSource, 'deleteMessageFromDB');
    assert.match(userDeleteRequest, /\$\{API_BASE\}\/sessions\/\$\{appState\.currentSession\.id\}\/messages\/\$\{msgWithId\.id\}/, 'chat delete helper must target current user session route');
    assert.match(userDeleteRequest, /Authorization['"]?\s*:\s*`Bearer\s+\$\{appState\.token\}`/, 'chat delete helper must use user Bearer auth');
    assert.doesNotMatch(userDeleteRequest, /admin\/messages|X-Admin-Token/, 'chat delete helper must never call the admin API');

    const adminDelete = extractNamedFunction(appSource, 'deleteAdminMessage');
    assert.match(adminDelete, /\$\{API_BASE\}\/admin\/messages\/\$\{messageId\}/, 'admin delete handler must target admin message route');
    assert.match(adminDelete, /X-Admin-Token['"]?\s*:\s*adminState\.token/, 'admin delete handler must use admin auth');
    assert.doesNotMatch(adminDelete, /appState\.currentSession|Bearer\s+\$\{appState\.token\}/, 'admin delete handler must not depend on chat state');
}

function checkSettingsPasswordTokenContinuation(appSource) {
    const tokenContinuation = extractNamedFunction(appSource, 'requireAndStoreRotatedUserSessionToken');
    assert.match(tokenContinuation, /typeof\s+data\?\.token\s*===\s*['"]string['"][\s\S]*\.trim\(\)/, 'rotated user tokens must be non-empty trimmed strings');
    assert.match(tokenContinuation, /if\s*\(\s*!rotatedToken\s*\)\s*\{[\s\S]*throw\s+new\s+Error/, 'missing rotated user tokens must fail closed');
    assert.match(tokenContinuation, /appState\.token\s*=\s*rotatedToken/, 'rotated user token must replace app state');
    assert.match(tokenContinuation, /localStorage\.setItem\(\s*RAI_TOKEN_KEY\s*,\s*rotatedToken\s*\)/, 'rotated user token must update the scoped storage key');

    const saveSettings = extractNamedFunction(appSource, 'saveSettings');
    const passwordRequestIndex = saveSettings.indexOf("`${API_BASE}/user/password`");
    const tokenContinuationIndex = saveSettings.indexOf('requireAndStoreRotatedUserSessionToken(');
    const configRequestIndex = saveSettings.indexOf("`${API_BASE}/user/config`");

    assert.ok(passwordRequestIndex >= 0, 'settings password save must call the password endpoint');
    assert.ok(tokenContinuationIndex > passwordRequestIndex, 'password response must continue through the strict token helper');
    assert.ok(configRequestIndex > tokenContinuationIndex, 'cloud config must run only after password token continuation');
    assert.match(saveSettings, /catch\s*\([^)]*\)\s*\{[\s\S]*if\s*\(\s*passwordUpdated\s*\)\s*\{[\s\S]*clearSettingsPasswordInputs\(\)[\s\S]*updateSettingsDirtyState\(\)/, 'partial failures after a committed password change must clear all password fields');

    const clearInputs = extractNamedFunction(appSource, 'clearSettingsPasswordInputs');
    for (const inputId of ['settingsCurrentPasswordInput', 'settingsNewPasswordInput', 'settingsConfirmPasswordInput']) {
        assert.ok(clearInputs.includes(`'${inputId}'`), `password cleanup must include ${inputId}`);
    }
}

function checkTwoFactorTokenContinuation(appSource) {
    for (const [functionName, expectedState] of [
        ['confirmTwoFactorSetup', 'true'],
        ['disableTwoFactor', 'false']
    ]) {
        const source = extractNamedFunction(appSource, functionName);
        const continuationIndex = source.indexOf('requireAndStoreRotatedUserSessionToken(');
        const stateIndex = source.indexOf(`two_factor_enabled: ${expectedState}`);
        const renderIndex = source.indexOf('renderTwoFactorSettings()');
        assert.ok(continuationIndex >= 0, `${functionName} must require a rotated session token`);
        assert.ok(stateIndex > continuationIndex, `${functionName} must not update 2FA state before token continuation`);
        assert.ok(renderIndex > stateIndex, `${functionName} must not update 2FA UI before token continuation`);
    }
}

function checkSideEffectSsrfAndUploadAtomicity(serverSource) {
    const toolBuilder = extractNamedFunction(serverSource, 'buildChatToolDefinitions');
    assert.match(toolBuilder, /if\s*\(\s*internetMode\s*\)[\s\S]*web_search[\s\S]*finance_quote/, 'internet mode must expose only search/finance read tools');
    assert.match(toolBuilder, /if\s*\(\s*imageGenerationRequested\s*\)[\s\S]*generate_image/, 'generate_image must require explicit image intent');
    const executor = extractNamedFunction(serverSource, 'executeNormalizedToolCall');
    assert.match(executor, /toolName\s*===\s*['"]generate_image['"][\s\S]*imageGenerationRequested\s*===\s*true/, 'image tool execution must be separately authorized');
    assert.match(executor, /if\s*\(\s*!authorized\s*\)[\s\S]*tool_not_authorized/, 'unauthorized model tool calls must be rejected before execution');

    // Generated images are fetched server-side and therefore need DNS/IP checks
    // on every redirect hop. Search-result images are only passed to the browser;
    // their validator must remain a zero-network literal URL filter so a DNS
    // rebinding/TOCTOU probe cannot be introduced accidentally.
    const outboundGuard = extractNamedFunction(serverSource, 'assertSafeOutboundImageUrl');
    assert.match(outboundGuard, /resolveImageUrlAddresses\s*\(/, 'server-fetched generated image URLs must resolve current DNS addresses');
    assert.match(outboundGuard, /addresses\.find[\s\S]*isPrivateOrReservedIp/, 'server-fetched generated image URLs must reject private/reserved resolved addresses');
    const generatedFetch = extractNamedFunction(serverSource, 'fetchGeneratedImageBuffer');
    const guardIndex = generatedFetch.indexOf('assertSafeOutboundImageUrl(currentUrl');
    const fetchIndex = generatedFetch.indexOf('fetchWithTimeout');
    assert.ok(guardIndex >= 0 && fetchIndex > guardIndex, 'each generated-image fetch hop must be DNS/IP validated before network I/O');
    assert.match(generatedFetch, /redirect\s*:\s*['"]manual['"]/, 'generated-image redirects must be handled manually and revalidated');
    assert.match(generatedFetch, /for\s*\([^)]*redirectCount/, 'generated-image redirects must be bounded');

    const searchImageValidator = extractNamedFunction(serverSource, 'validateImageUrl');
    assert.doesNotMatch(searchImageValidator, /\b(?:fetch|fetchWithTimeout|fetchSafeImageHead)\s*\(/, 'search image URL validation must perform zero server-side network I/O');
    assert.match(searchImageValidator, /hostname\s*===\s*['"]localhost['"]|\.endsWith\(\s*['"]\.localhost['"]\s*\)/, 'search image URL validation must reject loopback hostnames');
    assert.match(searchImageValidator, /net\.isIP\s*\([^)]+\)[\s\S]*isPrivateOrReservedIp\s*\(/, 'search image URL validation must reject private/reserved literal IP addresses');
    const searchImageFilter = extractNamedFunction(serverSource, 'filterValidImages');
    assert.doesNotMatch(searchImageFilter, /\b(?:fetch|fetchWithTimeout|fetchSafeImageHead)\s*\(/, 'search image filtering must never probe third-party URLs from the server');

    const uploadLedger = extractNamedFunction(serverSource, 'recordUploadedFileWithQuota');
    assert.match(uploadLedger, /withImmediateTransaction\s*\(/, 'upload quota check and ledger insert must share a dedicated transaction');
    assert.match(uploadLedger, /SELECT\s+COUNT\(\*\)[\s\S]*FROM\s+file_uploads/i, 'upload transaction must read current owner ledger totals');
    assert.match(uploadLedger, /fileCount\s*\+\s*1\s*>\s*maxFiles/, 'upload transaction must enforce max file count against the incoming row');
    assert.match(uploadLedger, /totalSize\s*\+\s*incoming\s*>\s*maxTotalBytes/, 'upload transaction must enforce total bytes against the incoming row');
    assert.match(uploadLedger, /INSERT\s+INTO\s+file_uploads/i, 'upload transaction must insert ownership ledger before commit');
}

function checkModelResolverContracts(serverSource, routeSummary) {
    const chatRoute = routeSummary._fullRoutes.find((route) => route.key === 'POST /api/chat/stream');
    assert.ok(chatRoute, 'chat route must exist');
    const disabledIndex = chatRoute.callSource.indexOf('isPublicModelDisabled');
    const restrictedClaudeIndex = chatRoute.callSource.search(/model\s*===\s*['"]claude-haiku['"]/);
    assert.ok(disabledIndex >= 0, 'chat route must enforce disabled model state');
    assert.ok(restrictedClaudeIndex < 0 || disabledIndex < restrictedClaudeIndex, 'disabled model must fall back to auto before membership rejection');

    const multimodalResolver = extractNamedFunction(serverSource, 'resolveVisibleAutoMultimodalModel');
    assert.doesNotMatch(multimodalResolver, /resolveVisibleAutoModel\s*\(/, 'multimodal auto resolver must not fall back to a text-only resolver');
    assert.match(multimodalResolver, /multimodal|requiresMultimodal/, 'multimodal resolver must enforce capability');

    const runtimeFallback = extractNamedFunction(serverSource, 'getRuntimeFallbackModelIds');
    assert.match(runtimeFallback, /requiresMultimodal/, 'runtime fallback list must be capability-aware');
    assert.match(runtimeFallback, /multimodal\s*===\s*true/, 'multimodal fallback must only select declared multimodal routes');
}

function checkModelVisibilityFallbackContracts(serverSource, routeSummary) {
    const visibleFallback = extractNamedFunction(serverSource, 'findVisibleAvailableRuntimeFallbackModelId');
    assert.match(visibleFallback, /await\s+getDisabledModelSet\s*\(/, 'visible fallback resolution must load the authoritative disabled-model set');
    assert.match(visibleFallback, /!disabled\.has\s*\(\s*modelId\s*\)/, 'visible fallback resolution must exclude every disabled candidate');
    assert.match(visibleFallback, /isRuntimeConfiguredModel\s*\(\s*modelId\s*\)/, 'visible fallback resolution must also require provider configuration');

    const visibleFreeFallback = extractNamedFunction(serverSource, 'resolveVisibleFreeFallbackModelId');
    assert.match(visibleFreeFallback, /findVisibleAvailableRuntimeFallbackModelId\s*\(/, 'free fallback selection must delegate to the async visibility-aware resolver');
    assert.doesNotMatch(visibleFreeFallback, /findAvailableRuntimeFallbackModelId\s*\(/, 'free fallback selection must never call the legacy visibility-blind resolver');

    const autoResolver = extractNamedFunction(serverSource, 'resolveVisibleAutoModel');
    assert.match(autoResolver, /await\s+getDisabledModelSet\s*\(/, 'auto resolution must load disabled-model state');
    assert.match(autoResolver, /!disabled\.has\s*\(\s*modelId\s*\)/, 'auto preferred candidates must exclude disabled models');
    assert.match(autoResolver, /findVisibleAvailableRuntimeFallbackModelId\s*\(/, 'auto exhaustion must continue through the visibility-aware fallback chain');

    const multimodalResolver = extractNamedFunction(serverSource, 'resolveVisibleAutoMultimodalModel');
    assert.match(multimodalResolver, /await\s+getDisabledModelSet\s*\(/, 'multimodal resolution must load disabled-model state');
    assert.match(multimodalResolver, /!disabled\.has\s*\(\s*modelId\s*\)/, 'multimodal resolution must exclude disabled candidates');
    assert.match(multimodalResolver, /MODEL_ROUTING\[modelId\]\?\.multimodal\s*===\s*true/, 'multimodal resolution must never choose a text-only route');
    assert.match(multimodalResolver, /isRuntimeConfiguredModel\s*\(\s*modelId\s*\)/, 'multimodal resolution must require provider configuration');
    assert.match(multimodalResolver, /\|\|\s*null/, 'multimodal exhaustion must return null instead of a text-only model');

    const runtimeFallback = extractNamedFunction(serverSource, 'tryUniversalRuntimeFallback');
    assert.match(runtimeFallback, /const\s+disabledModels\s*=\s*await\s+getDisabledModelSet\s*\(/, 'runtime failure fallback must snapshot disabled-model state');
    assert.match(runtimeFallback, /if\s*\(\s*disabledModels\.has\s*\(\s*fallbackModel\s*\)\s*\)[\s\S]*continue/, 'runtime failure fallback must skip disabled candidates before provider I/O');

    const chatRoute = routeSummary._fullRoutes.find((route) => route.key === 'POST /api/chat/stream');
    assert.ok(chatRoute, 'chat route must exist for visibility fallback contract');
    assert.doesNotMatch(chatRoute.callSource, /\b(?:resolveFreeFallbackModelId|findAvailableRuntimeFallbackModelId)\s*\(/, 'chat execution paths must not call visibility-blind fallback helpers');
    assert.match(chatRoute.callSource, /if\s*\(\s*!multimodalFallback\s*\)[\s\S]*sendMultimodalUnavailable\s*\(/, 'multimodal exhaustion must emit multimodal_unavailable instead of selecting text-only fallback');
}

function checkStaticContracts() {
    const serverSource = fs.readFileSync(SERVER_PATH, 'utf8');
    const appSource = fs.readFileSync(APP_PATH, 'utf8');
    const tokenSource = fs.readFileSync(TOKEN_PATH, 'utf8');
    const parsed = require('./beta-route-contract-audit').parseRoutes(serverSource);
    const routeSummary = auditRoutes();
    Object.defineProperty(routeSummary, '_fullRoutes', { value: parsed, enumerable: false });

    const checks = [
        ['token-purpose-and-auth-version-gate', 'required', () => checkTokenPurpose(serverSource, tokenSource, routeSummary)],
        ['sqlite-and-email-atomicity', 'required', () => checkTransactions(serverSource)],
        ['office-child-process-bounds', 'required', () => checkOfficeIsolation(serverSource)],
        ['frontend-xss-sinks', 'required', () => checkXssContracts(appSource)],
        ['beta-path-cache-storage-and-auth-isolation', 'required', () => checkBetaIsolationContracts(appSource)],
        ['frontend-composer-attachment-lifecycle', 'required', () => checkComposerAttachmentLifecycle(appSource)],
        ['frontend-chat-admin-delete-separation', 'required', () => checkFrontendMessageDeleteSeparation(appSource)],
        ['settings-password-token-continuation', 'required', () => checkSettingsPasswordTokenContinuation(appSource)],
        ['two-factor-token-continuation', 'required', () => checkTwoFactorTokenContinuation(appSource)],
        ['2fa-side-effect-ssrf-and-upload-atomicity', 'required', () => checkSideEffectSsrfAndUploadAtomicity(serverSource)],
        ['model-visibility-fallback-contract', 'required', () => checkModelVisibilityFallbackContracts(serverSource, routeSummary)],
        // The two groups below are intentionally advisory: the isolated HTTP regression
        // is authoritative for attachment persistence/ownership, and the live matrix plus
        // disabled-model simulation is authoritative for routing. Keeping them advisory
        // avoids coupling the gate to internal helper names during refactors.
        ['attachment-metadata-and-delete-contract', 'advisory', () => checkAttachmentContracts(serverSource)],
        ['model-resolver-order-and-capability', 'advisory', () => checkModelResolverContracts(serverSource, routeSummary)]
    ];

    const results = [];
    for (const [name, enforcement, check] of checks) {
        try {
            check();
            results.push({ name, enforcement, status: 'passed' });
        } catch (error) {
            results.push({ name, enforcement, status: 'failed', error: error.message });
        }
    }
    return results;
}

function main() {
    assert.ok(ROOT.endsWith(`${path.sep}beta版本`), `refusing unexpected project root: ${ROOT}`);
    const results = checkStaticContracts();
    for (const result of results) {
        const label = result.status === 'passed' ? 'PASS' : (result.enforcement === 'required' ? 'FAIL' : 'WARN');
        console.log(`${label} ${result.name}${result.error ? ` :: ${result.error}` : ''}`);
    }
    const failures = results.filter((result) => result.status === 'failed' && result.enforcement === 'required');
    assert.deepEqual(failures, [], `${failures.length} static security contract group(s) failed`);
    console.log('beta-static-security-contracts ok');
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(`beta-static-security-contracts failed: ${error.stack || error.message}`);
        process.exitCode = 1;
    }
}

module.exports = {
    ROOT,
    checkStaticContracts,
    extractNamedFunction
};
