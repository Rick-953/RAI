#!/usr/bin/env node

'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SERVER_PATH = path.join(PROJECT_ROOT, 'server.js');

// 2026-07-13 审查时确认的 92 条基线路由。修复可以新增显式列出的路由，
// 但不能静默删除或改名；这样路由清点既能发现回归，也不会阻止安全补丁扩展 API。
const BASELINE_ROUTE_LINES = `
GET /sw.js
GET /runtime-config.js
GET /site.webmanifest
GET /api/test
GET /api/version
GET /api/quote/:symbol
GET /api/auth/ztx6d/status
GET /api/auth/ztx6d/start
POST /api/auth/ztx6d/bind/start
GET /api/auth/ztx6d/callback
POST /api/auth/ztx6d/exchange
POST /api/auth/register
POST /api/auth/register/resend
POST /api/auth/register/verify
POST /api/auth/login/precheck
POST /api/auth/login
POST /api/auth/login/email-code/request
POST /api/auth/login/email-code/verify
POST /api/auth/password/reset/request
POST /api/auth/password/reset/confirm
POST /api/auth/login/2fa
GET /api/auth/verify
GET /api/user/profile
PUT /api/user/profile
POST /api/user/profile/email/verify
POST /api/user/profile/email/verify-current
POST /api/user/2fa/setup
POST /api/user/2fa/enable
POST /api/user/2fa/disable
PUT /api/user/password
DELETE /api/user/account
PUT /api/user/config
GET /api/user/memories
POST /api/user/memories
POST /api/user/memories/clear
PATCH /api/user/memories/:id
DELETE /api/user/memories/:id
POST /api/user/avatar
GET /api/sessions
POST /api/sessions
PUT /api/sessions/:id
DELETE /api/sessions/:id
GET /api/sessions/:id/messages
GET /api/sessions/:id/stream-events
GET /api/flows
POST /api/flows
GET /api/flows/:id
PUT /api/flows/:id
DELETE /api/flows/:id
GET /api/messages/:messageId/attachments
DELETE /api/sessions/:sessionId/messages/:messageId
PUT /api/sessions/:sessionId/messages/:messageId
PATCH /api/sessions/:sessionId/messages/:messageId/regeneration
GET /api/sessions/:sessionId/messages-before/:messageId
POST /api/upload
GET /api/uploads/:filename
POST /api/chat/stream
POST /api/chat/stop
POST /api/chat/interject
POST /api/messages/:messageId/feedback
GET /api/model-availability
GET /api/user/membership
POST /api/user/checkin
POST /api/user/tasks/pwa-install/complete
POST /api/user/tasks/bookmark-domain/complete
GET /api/announcements
POST /api/user/membership/redeem
POST /api/admin/login
GET /api/admin/verify
GET /api/admin/runtime-settings
PUT /api/admin/runtime-settings
GET /api/admin/models
PUT /api/admin/models/:modelId
GET /api/admin/announcements
POST /api/admin/announcements
PUT /api/admin/announcements/:id
DELETE /api/admin/announcements/:id
POST /api/admin/broadcast
GET /api/admin/stats
GET /api/admin/feedback
GET /api/admin/users
PUT /api/admin/users/:userId/password
GET /api/admin/users/:userId/detail
GET /api/admin/sessions/:sessionId/messages
GET /api/admin/users/:userId/messages
DELETE /api/admin/users/:userId
PUT /api/admin/users/:userId/membership
PUT /api/admin/users/:userId/points
GET /api/admin/messages
DELETE /api/admin/messages/:messageId
GET /api/admin/sessions
DELETE /api/admin/sessions/:sessionId
`.trim().split('\n');

const BASELINE_ROUTES = new Set(BASELINE_ROUTE_LINES);
const DECLARED_ADDITIONS = new Set([
    'DELETE /api/uploads/:filename'
]);

const PUBLIC_AUTH_ROUTES = new Set([
    'GET /api/auth/ztx6d/status',
    'GET /api/auth/ztx6d/start',
    'GET /api/auth/ztx6d/callback',
    'POST /api/auth/ztx6d/exchange',
    'POST /api/auth/register',
    'POST /api/auth/register/resend',
    'POST /api/auth/register/verify',
    'POST /api/auth/login/precheck',
    'POST /api/auth/login',
    'POST /api/auth/login/email-code/request',
    'POST /api/auth/login/email-code/verify',
    'POST /api/auth/password/reset/request',
    'POST /api/auth/password/reset/confirm',
    'POST /api/auth/login/2fa'
]);

function lineNumberAt(source, index) {
    return source.slice(0, index).split('\n').length;
}

function findBalancedCallEnd(source, openParenIndex) {
    let depth = 0;
    let quote = '';
    let escaped = false;
    let lineComment = false;
    let blockComment = false;

    for (let index = openParenIndex; index < source.length; index += 1) {
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
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === quote) {
                quote = '';
            }
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
        if (char === '(') depth += 1;
        if (char === ')') {
            depth -= 1;
            if (depth === 0) return index;
        }
    }
    throw new Error(`Unbalanced app route call beginning at offset ${openParenIndex}`);
}

function classifyProtection(route) {
    if (/\bauthenticateAdmin\b/.test(route.callSource)) return 'admin';
    if (/\bauthenticateToken\b/.test(route.callSource)) return 'user';
    if (
        route.key === 'GET /api/sessions/:id/stream-events'
        && /\bverifyAuthenticatedUserSession\b/.test(route.callSource)
    ) {
        return 'user';
    }
    return 'public';
}

function parseRoutes(source) {
    const routeRegex = /app\.(get|post|put|patch|delete)\(\s*(['"`])([^'"`]+)\2/g;
    const routes = [];
    let match;
    while ((match = routeRegex.exec(source))) {
        const openParenIndex = source.indexOf('(', match.index);
        const closeParenIndex = findBalancedCallEnd(source, openParenIndex);
        const method = match[1].toUpperCase();
        const routePath = match[3];
        const route = {
            method,
            path: routePath,
            key: `${method} ${routePath}`,
            line: lineNumberAt(source, match.index),
            callSource: source.slice(match.index, closeParenIndex + 1)
        };
        route.protection = classifyProtection(route);
        routes.push(route);
        routeRegex.lastIndex = closeParenIndex + 1;
    }
    return routes;
}

function expectedProtection(key) {
    if (key.startsWith('GET /api/admin/') || key.startsWith('POST /api/admin/')
        || key.startsWith('PUT /api/admin/') || key.startsWith('PATCH /api/admin/')
        || key.startsWith('DELETE /api/admin/')) {
        return key === 'POST /api/admin/login' ? 'public' : 'admin';
    }
    if (PUBLIC_AUTH_ROUTES.has(key)) return 'public';
    if (key === 'GET /api/auth/verify' || key === 'POST /api/auth/ztx6d/bind/start') return 'user';
    if (/^(GET|POST|PUT|PATCH|DELETE) \/api\/(user|sessions|flows|messages|upload(?:s)?|chat)(?:\/|$)/.test(key)) {
        return 'user';
    }
    return 'public';
}

function auditRoutes({ serverPath = SERVER_PATH } = {}) {
    const source = fs.readFileSync(serverPath, 'utf8');
    const routes = parseRoutes(source);
    const keys = routes.map((route) => route.key);
    const keySet = new Set(keys);
    const duplicateKeys = keys.filter((key, index) => keys.indexOf(key) !== index);
    const missingBaseline = [...BASELINE_ROUTES].filter((key) => !keySet.has(key));
    const undeclaredAdditions = keys.filter((key) => !BASELINE_ROUTES.has(key) && !DECLARED_ADDITIONS.has(key));
    const authMismatches = routes
        .map((route) => ({
            key: route.key,
            line: route.line,
            actual: route.protection,
            expected: expectedProtection(route.key)
        }))
        .filter((item) => item.actual !== item.expected);

    assert.equal(BASELINE_ROUTES.size, 92, 'route baseline must contain exactly 92 unique routes');

    const summary = {
        baselineCount: BASELINE_ROUTES.size,
        currentCount: routes.length,
        protectionCounts: routes.reduce((counts, route) => {
            counts[route.protection] = (counts[route.protection] || 0) + 1;
            return counts;
        }, {}),
        missingBaseline,
        undeclaredAdditions,
        duplicateKeys: [...new Set(duplicateKeys)],
        authMismatches,
        routes: routes.map(({ method, path: routePath, key, line, protection }) => ({
            method,
            path: routePath,
            key,
            line,
            protection
        }))
    };

    assert.deepEqual(summary.duplicateKeys, [], `duplicate route declarations: ${summary.duplicateKeys.join(', ')}`);
    assert.deepEqual(missingBaseline, [], `baseline routes missing: ${missingBaseline.join(', ')}`);
    assert.deepEqual(undeclaredAdditions, [], `undeclared route additions: ${undeclaredAdditions.join(', ')}`);
    assert.deepEqual(authMismatches, [], `route auth mismatches: ${JSON.stringify(authMismatches)}`);
    return summary;
}

function assertLoopbackAuditUrl(rawUrl) {
    const parsed = new URL(String(rawUrl || ''));
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const loopback = hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost';
    assert.equal(parsed.protocol, 'http:', 'dynamic auth matrix only accepts plain HTTP loopback URLs');
    assert.ok(loopback, `refusing non-loopback audit URL: ${parsed.origin}`);
    assert.ok(!['3009', '3010', '80', '443'].includes(parsed.port), `refusing known formal/beta/default port: ${parsed.port}`);
    assert.ok(!/rai\.(?:000339\.xyz|rick\.quest)/i.test(parsed.href), 'refusing production hostname');
    return parsed.origin;
}

function materializeRoutePath(routePath) {
    return routePath.replace(/:([A-Za-z0-9_]+)/g, (_whole, name) => {
        if (/message/i.test(name)) return '999999999';
        if (/user/i.test(name)) return '999999999';
        if (/symbol/i.test(name)) return 'AUDIT';
        if (/filename/i.test(name)) return 'audit-missing.txt';
        return 'audit-missing-id';
    });
}

async function requestMissingAuth(baseUrl, route, timeoutMs = 4000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Audit-Probe': 'missing-auth-only'
    };
    const options = { method: route.method, headers, signal: controller.signal };
    if (!['GET', 'HEAD'].includes(route.method)) options.body = '{}';
    try {
        const response = await fetch(`${baseUrl}${materializeRoutePath(route.path)}`, options);
        const body = await response.text().catch(() => '');
        return { key: route.key, protection: route.protection, status: response.status, body: body.slice(0, 300) };
    } finally {
        clearTimeout(timer);
    }
}

async function runMissingAuthMatrix(baseUrl, routeSummary = auditRoutes()) {
    const safeBaseUrl = assertLoopbackAuditUrl(baseUrl);
    const protectedRoutes = routeSummary.routes.filter((route) => route.protection !== 'public');
    const results = [];
    for (const route of protectedRoutes) {
        results.push(await requestMissingAuth(safeBaseUrl, route));
    }
    const failures = results.filter((item) => ![401, 403].includes(item.status));
    assert.deepEqual(failures, [], `protected routes accepted missing auth: ${JSON.stringify(failures)}`);
    return { checked: results.length, failures, results };
}

function printHuman(summary) {
    console.log(`ROUTE_BASELINE=${summary.baselineCount}`);
    console.log(`ROUTE_CURRENT=${summary.currentCount}`);
    console.log(`ROUTE_PROTECTION=${JSON.stringify(summary.protectionCounts)}`);
    for (const route of summary.routes) {
        console.log(`${String(route.line).padStart(5)}  ${route.protection.padEnd(6)}  ${route.key}`);
    }
}

async function main() {
    const args = process.argv.slice(2);
    const json = args.includes('--json');
    const baseArg = args.find((arg) => arg.startsWith('--base-url='));
    const summary = auditRoutes();
    let dynamic = null;
    if (baseArg) dynamic = await runMissingAuthMatrix(baseArg.slice('--base-url='.length), summary);
    if (json) {
        console.log(JSON.stringify({ ...summary, dynamic }, null, 2));
    } else {
        printHuman(summary);
        if (dynamic) console.log(`MISSING_AUTH_MATRIX=${dynamic.checked}`);
        console.log('beta-route-contract-audit ok');
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`beta-route-contract-audit failed: ${error.stack || error.message}`);
        process.exitCode = 1;
    });
}

module.exports = {
    BASELINE_ROUTES,
    DECLARED_ADDITIONS,
    PROJECT_ROOT,
    SERVER_PATH,
    assertLoopbackAuditUrl,
    auditRoutes,
    parseRoutes,
    runMissingAuthMatrix
};
