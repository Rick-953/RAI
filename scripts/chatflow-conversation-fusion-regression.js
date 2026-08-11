#!/usr/bin/env node

'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_PATHS = {
    server: path.join(ROOT, 'server.js'),
    app: path.join(ROOT, 'public', 'app.js'),
    index: path.join(ROOT, 'public', 'index.html'),
    styles: path.join(ROOT, 'public', 'styles.css')
};

function readSources() {
    const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.equal(packageJson.name, 'rai', `refusing unexpected project: ${packageJson.name || '(unnamed)'}`);
    return Object.fromEntries(Object.entries(SOURCE_PATHS).map(([name, filename]) => {
        assert.ok(fs.existsSync(filename), `missing formal source: ${filename}`);
        return [name, fs.readFileSync(filename, 'utf8')];
    }));
}

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
    const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
    assert.ok(match, `function ${name} must exist`);
    const parameterOpen = source.indexOf('(', match.index);
    const parameterClose = findBalancedEnd(source, parameterOpen, '(', ')');
    const bodyOpen = source.indexOf('{', parameterClose + 1);
    return source.slice(match.index, findBalancedEnd(source, bodyOpen) + 1);
}

function sliceBetween(source, startMarker, endMarker, label) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start + startMarker.length);
    assert.ok(start >= 0 && end > start, `missing ${label || startMarker}`);
    return source.slice(start, end);
}

function assertMatchesAll(source, patterns, message) {
    for (const pattern of patterns) {
        assert.ok(pattern.test(source), `${message}: missing ${pattern}`);
    }
}

function assertMatchesAny(source, patterns, message) {
    assert.ok(patterns.some((pattern) => pattern.test(source)), message);
}

function normalizeSql(sql) {
    return String(sql || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function createMigrationFixture(initialFlows) {
    let state = {
        flows: Object.fromEntries(initialFlows.map((flow) => [flow.id, JSON.parse(JSON.stringify(flow))])),
        sessions: {},
        messages: [],
        nextMessageId: 100
    };
    let failOnFlowUpdate = false;

    const cloneState = () => JSON.parse(JSON.stringify(state));
    const withMainDbTransaction = async (worker) => {
        const draft = cloneState();
        const tx = {
            async get(sql, params = []) {
                const normalized = normalizeSql(sql);
                if (normalized.includes('from flows')) {
                    const row = draft.flows[String(params[0])];
                    if (!row || Number(row.user_id) !== Number(params[1])) return null;
                    const linkedSession = draft.sessions[String(row.session_id || '')] || null;
                    return {
                        ...JSON.parse(JSON.stringify(row)),
                        linked_session_id: linkedSession?.id || null,
                        linked_session_user_id: linkedSession?.user_id ?? null
                    };
                }
                if (normalized.includes('from sessions')) {
                    const row = draft.sessions[String(params[0])];
                    return row && Number(row.user_id) === Number(params[1]) ? { id: row.id } : null;
                }
                throw new Error(`migration fixture does not implement get: ${normalized}`);
            },
            async run(sql, params = []) {
                const normalized = normalizeSql(sql);
                if (normalized.startsWith('insert into sessions')) {
                    const [id, userId, title, model, sessionKind] = params;
                    assert.ok(!draft.sessions[id], `duplicate fixture session ${id}`);
                    draft.sessions[id] = { id, user_id: userId, title, model, session_kind: sessionKind };
                    return { changes: 1, lastID: id };
                }
                if (normalized.startsWith('insert into messages')) {
                    const [sessionId, role, content, createdAt] = params;
                    const id = draft.nextMessageId;
                    draft.nextMessageId += 1;
                    draft.messages.push({ id, session_id: sessionId, role, content, created_at: createdAt });
                    return { changes: 1, lastID: id };
                }
                if (normalized.startsWith('update flows set session_id')) {
                    if (failOnFlowUpdate) throw new Error('injected_flow_update_failure');
                    const flowId = String(params.at(-2));
                    const userId = Number(params.at(-1));
                    const row = draft.flows[flowId];
                    if (!row || Number(row.user_id) !== userId) return { changes: 0 };
                    row.session_id = params[0];
                    row.canvas_state = params[1];
                    return { changes: 1 };
                }
                if (normalized.includes('conversation_sync_state')) return { changes: 1 };
                throw new Error(`migration fixture does not implement run: ${normalized}`);
            }
        };
        const result = await worker(tx);
        state = draft;
        return result;
    };

    return {
        withMainDbTransaction,
        snapshot: () => cloneState(),
        setFailOnFlowUpdate(value) {
            failOnFlowUpdate = Boolean(value);
        }
    };
}

function buildLegacyMigrationHarness(server) {
    const factory = new Function(
        'FLOW_DEFAULT_CANVAS_STATE',
        'ensureChatFlowBaseColumns',
        'withMainDbTransaction',
        'crypto',
        [
            extractNamedFunction(server, 'cloneFlowDefaultCanvasState'),
            extractNamedFunction(server, 'safeJsonParse'),
            extractNamedFunction(server, 'normalizeFlowViewport'),
            extractNamedFunction(server, 'normalizeFlowCanvasNode'),
            extractNamedFunction(server, 'normalizeFlowCanvasState'),
            extractNamedFunction(server, 'normalizeLegacyFlowMessageTimestamp'),
            extractNamedFunction(server, 'normalizeLegacyFlowMessageEntries'),
            extractNamedFunction(server, 'normalizeLegacyFlowMessages'),
            extractNamedFunction(server, 'migrateFlowCanvasMessageReferences'),
            extractNamedFunction(server, 'migrateLegacyFlowInTransaction'),
            extractNamedFunction(server, 'migrateLegacyFlowRow'),
            'return { migrateLegacyFlowRow };'
        ].join('\n\n')
    );
    return (withMainDbTransaction) => factory(
        Object.freeze({ nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }),
        async () => undefined,
        withMainDbTransaction,
        crypto
    );
}

function testFlowSchemaAndStartupMigration({ server }) {
    const schema = sliceBetween(server, 'CREATE TABLE IF NOT EXISTS flows', 'CREATE TABLE IF NOT EXISTS auth_ztx6d_rt', 'flows schema');
    assert.match(schema, /session_id\s+TEXT/i, 'flows must remain linked to sessions');
    assert.match(schema, /canvas_revision\s+INTEGER[^,]*DEFAULT\s+0/i, 'flows must persist a monotonic canvas revision');
    assert.match(server, /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS[^\n;]*flows\s*\(\s*session_id\s*\)/i,
        'flows.session_id must have a unique index');
    const ensureBase = extractNamedFunction(server, 'ensureChatFlowBaseColumns');
    assert.match(ensureBase, /ensureFlowCanvasRevisionColumn/, 'existing databases must gain canvas_revision');
    const finalizeSchema = extractNamedFunction(server, 'finalizeChatFlowSchemaInTransaction');
    assert.match(finalizeSchema, /session_id\s+TEXT\s+NOT\s+NULL/i,
        'the finalized flows table must require a session mapping');
    assert.match(finalizeSchema, /CREATE\s+UNIQUE\s+INDEX[\s\S]*session_id/i,
        'the finalized flows table must enforce one canvas per session');
    const migrateAll = extractNamedFunction(server, 'migrateAllLegacyFlows');
    assert.match(migrateAll, /migrateLegacyFlowInTransaction/,
        'bulk migration must reuse the transaction-scoped row migration');
    assert.match(migrateAll, /validLink[\s\S]{0,300}continue/,
        'bulk migration must skip already valid one-to-one mappings');
    assert.match(server, /chatFlowStartupReady[\s\S]{0,500}ensureChatFlowSchemaColumns\s*\(/,
        'legacy migration must run after database initialization');
}

async function testLegacyMigrationFixture({ server }) {
    const legacy = {
        id: 'flow-legacy',
        user_id: 7,
        title: 'Legacy canvas',
        session_id: null,
        chat_history: JSON.stringify([
            { role: 'user', content: 'first', timestamp: 1_720_000_000 },
            { role: 'system', content: 'must not migrate' },
            { role: 'assistant', content: 'second', timestamp: 1_720_000_001 },
            { role: 'user', content: 'third', timestamp: 1_720_000_002 }
        ]),
        canvas_state: JSON.stringify({
            nodes: [
                { id: 'n1', sourceIndex: 0 },
                { id: 'n2', sourceIndex: 3 },
                { id: 'n3', sourceMessageId: 999 }
            ],
            edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
            viewport: { x: 12, y: -3, zoom: 1.25 }
        })
    };
    const fixture = createMigrationFixture([legacy]);
    const harness = buildLegacyMigrationHarness(server)(fixture.withMainDbTransaction);
    const firstResult = await harness.migrateLegacyFlowRow(legacy, 7);
    const first = fixture.snapshot();
    assert.ok(firstResult?.session_id, 'legacy migration must link a new session');
    assert.equal(Object.keys(first.sessions).length, 1, 'one legacy flow must create exactly one session');
    assert.equal(first.messages.length, 3, 'message delta must equal the valid legacy history length');
    assert.deepEqual(first.messages.map((message) => message.role), ['user', 'assistant', 'user']);
    assert.deepEqual(first.messages.map((message) => message.content), ['first', 'second', 'third']);
    assert.ok(first.messages.every((message) => message.session_id === firstResult.session_id));
    assert.equal(first.sessions[firstResult.session_id].session_kind, 'flow', 'legacy session_kind remains compatible');
    const migratedCanvas = JSON.parse(first.flows[legacy.id].canvas_state);
    assert.equal(migratedCanvas.nodes[0].sourceMessageId, first.messages[0].id);
    assert.equal(migratedCanvas.nodes[1].sourceMessageId, first.messages[2].id);
    assert.equal(migratedCanvas.nodes[2].sourceMessageId, 999, 'an existing sourceMessageId must win over sourceIndex');

    await harness.migrateLegacyFlowRow(legacy, 7);
    const second = fixture.snapshot();
    assert.equal(Object.keys(second.sessions).length, 1, 'a stale retry must not create a second session');
    assert.equal(second.messages.length, 3, 'a stale retry must not duplicate migrated messages');
    assert.equal(second.flows[legacy.id].session_id, first.flows[legacy.id].session_id);
}

async function testLegacyMigrationRollback({ server }) {
    const legacy = {
        id: 'flow-rollback',
        user_id: 9,
        title: 'Rollback fixture',
        session_id: null,
        chat_history: JSON.stringify([{ role: 'user', content: 'must roll back' }]),
        canvas_state: JSON.stringify({ nodes: [{ id: 'n1', sourceIndex: 0 }], edges: [] })
    };
    const fixture = createMigrationFixture([legacy]);
    const harness = buildLegacyMigrationHarness(server)(fixture.withMainDbTransaction);
    fixture.setFailOnFlowUpdate(true);
    await assert.rejects(harness.migrateLegacyFlowRow(legacy, 9), /injected_flow_update_failure/);
    const rolledBack = fixture.snapshot();
    assert.equal(Object.keys(rolledBack.sessions).length, 0, 'failed migration must roll back the session');
    assert.equal(rolledBack.messages.length, 0, 'failed migration must roll back messages');
    assert.equal(rolledBack.flows[legacy.id].session_id, null, 'failed migration must leave the flow unmapped');
}

function testCanvasApiReadContract({ server }) {
    const route = sliceBetween(
        server,
        "app.get('/api/sessions/:id/canvas'",
        "app.put('/api/sessions/:id/canvas'",
        'session canvas GET route'
    );
    assert.match(route, /authenticateToken/);
    assert.match(route, /req\.user\.userId/, 'canvas reads must be owner-scoped');
    assert.match(route, /sessions[\s\S]*user_id|user_id[\s\S]*sessions/i, 'canvas reads must verify session ownership');
    assert.match(route, /buildSessionCanvasPayload\s*\(/, 'canvas GET must use the normalized response builder');
    const payloadBuilder = extractNamedFunction(server, 'buildSessionCanvasPayload');
    assertMatchesAll(payloadBuilder, [
        /enabled/,
        /flow_id/,
        /canvas_state/,
        /revision/,
        /updated_at/
    ], 'canvas GET response is incomplete');
}

function testCanvasApiWriteContract({ server }) {
    const route = sliceBetween(
        server,
        "app.put('/api/sessions/:id/canvas'",
        "app.get('/api/flows'",
        'session canvas PUT route'
    );
    assert.match(route, /authenticateToken/);
    assert.match(route, /withMainDbTransaction/, 'canvas saves must be atomic');
    assert.match(route, /base_?revision/i, 'canvas saves must require the client base revision');
    assert.match(route, /canvas_revision_conflict/);
    assert.match(route, /res\.status\(409\)/, 'revision conflicts must return HTTP 409');
    assert.match(route, /INSERT\s+INTO\s+flows/i, 'first canvas save must create a flow');
    assert.match(route, /canvas_revision\s*=\s*canvas_revision\s*\+\s*1/i,
        'existing canvas saves must advance the revision atomically');
    assert.match(route, /UPDATE\s+sessions\s+SET\s+updated_at\s*=\s*CURRENT_TIMESTAMP/i,
        'canvas saves must refresh the conversation timestamp');
    assert.match(server, /const\s+bumpConversationRevisionSql[\s\S]{0,300}conversation_sync_state/i,
        'the session sync trigger helper must advance the manifest revision');
    assert.match(server, /CREATE\s+TRIGGER\s+IF\s+NOT\s+EXISTS\s+rai_sync_sessions_update[\s\S]{0,240}bumpConversationRevisionSql/i,
        'session timestamp updates must invoke the manifest revision trigger helper');
    assert.doesNotMatch(route, /UPDATE\s+sessions[\s\S]{0,160}messages_revision/i,
        'canvas-only saves must not change messages_revision');
}

function testSessionManifestAndListContract({ server }) {
    const manifest = extractNamedFunction(server, 'buildConversationManifestForUser');
    assert.match(manifest, /LEFT\s+JOIN\s+flows\s+f\s+ON\s+f\.session_id\s*=\s*s\.id/i);
    assertMatchesAll(manifest, [
        /has_canvas/,
        /flow_id/,
        /canvas_revision/,
        /canvas_updated_at/
    ], 'manifest must expose canvas metadata');
    assert.match(manifest, /session_kind[^\n]*['"]flow['"]|['"]flow['"][^\n]*session_kind/i,
        'manifest must include legacy flow sessions');

    const listRoute = sliceBetween(server, "app.get('/api/sessions'", "app.post('/api/sessions'", 'sessions list route');
    assert.match(listRoute, /LEFT\s+JOIN\s+flows\s+f\s+ON\s+f\.session_id\s*=\s*s\.id/i);
    assertMatchesAll(listRoute, [/has_canvas/, /flow_id/, /canvas_revision/, /canvas_updated_at/],
        'session list must expose canvas metadata');
    assert.match(listRoute, /['"]flow['"]/, 'session list must not filter flow sessions out');
}

function testSessionTitleAndDeleteCascade({ server }) {
    const updateRoute = sliceBetween(server, "app.put('/api/sessions/:id'", "app.delete('/api/sessions/:id'", 'session update route');
    assert.match(updateRoute, /UPDATE\s+flows\s+SET\s+title/i, 'renaming a session must synchronize its flow title');
    assert.match(updateRoute, /user_id\s*=\s*\?/i, 'flow title synchronization must remain owner-scoped');

    const deleteHelper = extractNamedFunction(server, 'deleteOwnedSessionWithRelatedData');
    const flowDeleteIndex = deleteHelper.search(/DELETE\s+FROM\s+flows/i);
    const sessionDeleteIndex = deleteHelper.search(/DELETE\s+FROM\s+sessions/i);
    assert.ok(flowDeleteIndex >= 0 && sessionDeleteIndex > flowDeleteIndex,
        'session deletion must delete the related flow before the session');
    assert.match(deleteHelper, /withMainDbTransaction|\btx\./, 'session and flow deletion must share one transaction');

    const legacyDelete = sliceBetween(server, "app.delete('/api/flows/:id'", '// ==================== \u6d88\u606f\u7ba1\u7406API', 'legacy flow delete route');
    assert.match(legacyDelete, /deleteOwnedSessionWithRelatedData/,
        'legacy flow deletion must reuse the unified session cascade');
}

function testLegacyFlowApiCompatibility({ server }) {
    const routes = [
        sliceBetween(server, "app.get('/api/flows'", "app.post('/api/flows'", 'legacy flow list route'),
        sliceBetween(server, "app.post('/api/flows'", "app.get('/api/flows/:id'", 'legacy flow create route'),
        sliceBetween(server, "app.get('/api/flows/:id'", "app.put('/api/flows/:id'", 'legacy flow read route'),
        sliceBetween(server, "app.put('/api/flows/:id'", "app.delete('/api/flows/:id'", 'legacy flow update route'),
        sliceBetween(server, "app.delete('/api/flows/:id'", '// ==================== \u6d88\u606f\u7ba1\u7406API', 'legacy flow delete route')
    ];
    for (const route of routes) {
        assert.match(route, /authenticateToken/, 'every legacy flow route must remain authenticated');
        assert.match(route, /req\.user\.userId/, 'every legacy flow route must stay owner-scoped');
    }
    assert.match(routes[2], /ensureFlowRecord\s*\(/, 'legacy reads must migrate and return the linked session');
    assert.match(routes[3], /canvas_revision\s*=\s*canvas_revision\s*\+\s*1/i,
        'legacy canvas writes must share the monotonic revision contract');
    assert.match(routes[3], /canvas_revision_conflict/, 'legacy optimistic conflicts must use the same error code');
}

function testUnifiedServerStreamCanvasContract({ server }) {
    const route = sliceBetween(server, "app.post('/api/chat/stream'", "app.post('/api/chat/stop'", 'streaming chat route');
    assertMatchesAll(route, [/\bflowId\b/, /\bcanvasContext\b/, /\bcanvasApplyMode\b/],
        'the single chat stream route must retain the canvas request fields');
    assert.match(route, /ensureFlowRecord\(flowId,\s*req\.user\.userId\)/,
        'streaming canvas requests must resolve an owner-scoped flow');
    assert.match(route, /sessionId\s*=\s*flowRecord\.session_id/,
        'canvas requests must reuse the flow-linked conversation session');
    assert.match(route, /buildFlowCanvasSystemInstruction\s*\(/,
        'the unified stream must retain the reviewed/direct canvas patch protocol');
}

function testUnifiedSidebarAndComposer({ app, index }) {
    for (const retiredId of ['flowGroup', 'flowList', 'newFlowBtn', 'chatflowMessages', 'chatflowMessageInput', 'chatflowSendBtn', 'chatflowStopBtn', 'chatflowModelSelect', 'chatflowModelMenu']) {
        assert.doesNotMatch(index, new RegExp(`id=["']${retiredId}["']`), `retired independent ChatFlow control remains: ${retiredId}`);
    }
    assert.doesNotMatch(index, /data-i18n=["']sidebar-flows["']/, 'the sidebar must not retain a separate ChatFlow group');
    assert.equal((index.match(/id=["']messageInput["']/g) || []).length, 1, 'there must be one main composer textarea');
    assert.equal((index.match(/id=["']sendBtn["']/g) || []).length, 1, 'there must be one main send button');
    for (const retiredRuntimeId of ['chatflowMessages', 'chatflowMessageInput', 'chatflowSendBtn', 'chatflowStopBtn', 'chatflowModelSelect', 'chatflowModelMenu']) {
        assert.doesNotMatch(app, new RegExp(`getElementById\\(["']${retiredRuntimeId}["']\\)`),
            `retired ChatFlow runtime control remains: ${retiredRuntimeId}`);
    }
    assert.doesNotMatch(app, /function\s+(?:createChatFlowMessageElement|renderChatFlowMessages)\s*\(/,
        'the independent ChatFlow message renderer must not remain');
    assert.match(app, /sessionHasCanvas\(session\)[\s\S]{0,500}session-canvas-marker/,
        'canvas conversations need a marker in the unified session list');
    assertMatchesAny(index, [
        /id=["'](?:canvasToggleBtn|chatCanvasToggle|conversationCanvasToggle)["']/,
        /data-rai-click=["'][^"']*(?:toggleCanvas|CanvasToggle)[^"']*["']/
    ], 'the main composer must expose a canvas toggle');
    assert.match(index, /aria-pressed=["']false["']/, 'the canvas toggle must expose pressed state');
}

function testUnifiedSendMessageCanvasContract({ app }) {
    const sendMessage = sliceBetween(
        app,
        'async function sendMessage(',
        'function handleSendButtonClick(',
        'main sendMessage implementation'
    );
    assert.ok(/(?:\/api\/chat\/stream|\$\{API_BASE\}\/chat\/stream)/.test(sendMessage),
        'sendMessage must own the streaming chat request');
    assertMatchesAll(sendMessage, [
        /flowId/,
        /canvasContext/,
        /canvasApplyMode/
    ], 'sendMessage must carry the active canvas contract');
    assert.doesNotMatch(app, /(?:async\s+)?function\s+sendChatFlowMessage\s*\(/,
        'a second ChatFlow send path must not remain');
}

function testCanvasLayoutAndPersistence({ app, styles }) {
    assert.match(app, /CHATFLOW_DESKTOP_CHAT_WIDTH_STORAGE_KEY\s*=\s*['"]rai_chat_canvas_desktop_chat_width['"]/,
        'desktop split width needs a stable local preference key');
    assert.match(app, /localStorage\.setItem\(CHATFLOW_DESKTOP_CHAT_WIDTH_STORAGE_KEY/,
        'desktop split width must persist locally');
    assert.match(app, /AbortController/, 'canvas requests must be abortable during session switches');
    const loadCanvas = extractNamedFunction(app, 'loadSessionCanvas');
    assert.match(loadCanvas, /generation\s*!==\s*chatFlowState\.loadGeneration/,
        'late canvas loads must be rejected after a newer load starts');
    assert.match(loadCanvas, /normalizedSessionId\s*!==\s*String\(appState\.currentSession\?\.id/,
        'late canvas loads must be rejected after a session switch');
    const saveCanvas = extractNamedFunction(app, 'persistCurrentCanvasSnapshot');
    assert.match(saveCanvas, /generation\s*!==\s*appState\.sessionNavigationGeneration/,
        'late canvas saves must be rejected after a session switch');
    assert.match(styles, /\.main-content\.canvas-open[\s\S]{0,900}var\(--chatflow-desktop-chat-width/i,
        'desktop canvas layout must consume the persisted chat width');
    assert.match(styles, /@media\s*\([^)]*max-width\s*:\s*1024px[^)]*\)[\s\S]{0,6000}\.main-content\.canvas-open[\s\S]{0,900}(?:flex-direction\s*:\s*column|grid-template-(?:rows|areas))/i,
        'mobile and tablet canvas layout must stack vertically');
    assertMatchesAll(app, [
        /CHATFLOW_MOBILE_PANEL_MIN\s*=\s*30/,
        /CHATFLOW_MOBILE_PANEL_MAX\s*=\s*70/,
        /CHATFLOW_MOBILE_PANEL_DEFAULT\s*=\s*50/,
        /Math\.max\(\s*CHATFLOW_MOBILE_PANEL_MIN,\s*Math\.min\(CHATFLOW_MOBILE_PANEL_MAX/
    ], 'mobile canvas height must default to 50vh and clamp to 30-70vh');
}

function testLazyCanvasCreationAndConflictRecovery({ app }) {
    const canPersist = extractNamedFunction(app, 'canPersistCurrentCanvas');
    assert.match(canPersist, /classic-temp/, 'classic unsaved temporary chats must not persist a canvas');

    const toggleCanvas = extractNamedFunction(app, 'toggleSessionCanvas');
    assert.doesNotMatch(toggleCanvas, /createNewSession\s*\(/,
        'opening an empty canvas must not create a database session');
    assert.match(toggleCanvas, /resetUnifiedCanvasState\s*\(/,
        'opening an empty new-chat canvas must retain an in-memory draft');

    const ensureSession = extractNamedFunction(app, 'ensureCanvasSessionForPersistence');
    assert.match(ensureSession, /createNewSession\s*\(/,
        'the first canvas mutation must lazily create a persistent session');
    assert.match(ensureSession, /preserveCanvasDraft\s*:\s*true/,
        'lazy session creation must preserve the draft canvas');

    const saveCanvas = extractNamedFunction(app, 'persistCurrentCanvasSnapshot');
    assert.match(saveCanvas, /base_revision\s*:\s*baseRevision/,
        'canvas saves must send their optimistic base revision');
    assert.match(saveCanvas, /response\.status\s*===\s*409[\s\S]*loadSessionCanvas\s*\(/,
        'canvas revision conflicts must reload instead of overwriting remote state');

    const loadSession = sliceBetween(app, 'async function loadSession(', 'function cancelLiveStreamRender(', 'loadSession canvas lifecycle');
    assert.match(loadSession, /abortSessionCanvasWork\s*\(/,
        'switching conversations must abort outstanding canvas work');
    assert.match(loadSession, /shouldOpenCanvasForSession\s*\(/,
        'legacy flow sessions and saved per-session preferences must reopen the canvas');
}

function testMessageToCanvasContract({ app, index }) {
    assertMatchesAny(app, [
        /function\s+(?:add|append)MessageToCanvas\s*\(/,
        /(?:add|append)MessageToCanvas\s*=\s*(?:async\s*)?\(/
    ], 'messages need an explicit add-to-canvas action');
    assertMatchesAny(`${index}\n${app}`, [
        /data-rai-click=["'][^"']*(?:add|append)MessageToCanvas[^"']*["']/,
        /(?:add|append)-message-to-canvas/i,
        /addEventListener\(['"]click['"],\s*\(\)\s*=>\s*(?:add|append)MessageToCanvas\(message\)\)/
    ], 'the add-to-canvas action must be reachable from rendered messages');
    assert.ok((app.match(/appendChild\(createCanvasMessageAction\(message\)\)/g) || []).length >= 2,
        'both user and assistant messages need the add-to-canvas action');
    assert.match(app, /dragstart/, 'desktop messages must support drag-to-canvas');
    assert.match(app, /sourceMessageId/, 'canvas nodes added from messages must preserve message identity');
}

async function main() {
    const sources = readSources();
    const tests = [
        ['flow_schema_and_startup_migration', testFlowSchemaAndStartupMigration],
        ['legacy_migration_idempotence_and_mapping', testLegacyMigrationFixture],
        ['legacy_migration_transaction_rollback', testLegacyMigrationRollback],
        ['canvas_api_read_contract', testCanvasApiReadContract],
        ['canvas_api_write_revision_contract', testCanvasApiWriteContract],
        ['session_manifest_and_list_canvas_metadata', testSessionManifestAndListContract],
        ['session_title_and_delete_cascade', testSessionTitleAndDeleteCascade],
        ['legacy_flow_api_compatibility', testLegacyFlowApiCompatibility],
        ['unified_server_stream_canvas_contract', testUnifiedServerStreamCanvasContract],
        ['unified_sidebar_and_single_composer', testUnifiedSidebarAndComposer],
        ['single_send_message_canvas_contract', testUnifiedSendMessageCanvasContract],
        ['responsive_canvas_layout_and_request_guards', testCanvasLayoutAndPersistence],
        ['lazy_canvas_creation_and_conflict_recovery', testLazyCanvasCreationAndConflictRecovery],
        ['message_add_and_drag_to_canvas', testMessageToCanvasContract]
    ];
    const failures = [];
    let passed = 0;

    for (const [name, test] of tests) {
        try {
            await test(sources);
            passed += 1;
        } catch (error) {
            failures.push({ name, error });
        }
    }

    if (failures.length) {
        for (const failure of failures) {
            console.error(`FAIL ${failure.name}: ${failure.error.message}`);
        }
        console.error(`chatflow conversation fusion regression failed: ${passed}/${tests.length} checks passed`);
        process.exitCode = 1;
        return;
    }

    console.log(`chatflow conversation fusion regression passed: ${passed}/${tests.length} checks`);
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`chatflow conversation fusion regression failed: ${error.stack || error.message}`);
        process.exitCode = 1;
    });
}

module.exports = {
    buildLegacyMigrationHarness,
    createMigrationFixture,
    testLegacyMigrationFixture,
    testLegacyMigrationRollback
};
