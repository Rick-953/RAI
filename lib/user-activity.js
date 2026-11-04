'use strict';

const crypto = require('node:crypto');
const net = require('node:net');
const rateLimit = require('express-rate-limit');
const { trace } = require('./diagnostic-trace');
const RETENTION_MS = 30 * 86400000;
const KINDS = new Set(['ui', 'http', 'stream', 'error', 'navigation', 'app']);
const NUMBERS = new Set(['status', 'durationMs', 'hresult', 'events', 'contentChars', 'reasoningChars', 'toolEvents', 'firstContentMs', 'firstReasoningMs', 'inputTokens', 'outputTokens', 'cachedTokens', 'cacheWriteTokens', 'dropped', 'uiStreaming', 'uiSending', 'headerMs', 'attempt']);
const label = value => typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,160}$/.test(value) ? value : null;
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null;
function clientContext(value = {}) {
    if (!value || typeof value !== 'object') return {};
    const safe = {};
    if (typeof value.timezone === 'string' && /^[A-Za-z0-9 _+.:/-]{1,100}$/.test(value.timezone)) safe.timezone = value.timezone;
    for (const key of ['timezone','locale','region','uiLanguage','theme','themePreference','systemTheme','os','osVersion','architecture','deviceFamily','appVersion','selectedModel','reasoningProfile','mode','actualModel','reportedModel','actualReasoningProfile','provider','memoryMode','researchModeName','uiSurface','connectionType','uiStyle','finishReason','protocol']) if (label(value[key])) safe[key] = value[key];
    for (const key of ['thinkingMode','internetMode','agentMode','researchMode','customApiMode']) if (typeof value[key] === 'boolean') safe[key] = value[key];
    for (const key of ['screenWidth','screenHeight','viewportWidth','viewportHeight','scale','utcOffsetMinutes','thinkingBudget']) if (Number.isFinite(value[key]) && Math.abs(value[key]) <= 1000000) safe[key] = value[key];
    for (const key of ['selectedSkills','loadedSkills','features']) if (Array.isArray(value[key])) safe[key] = value[key].filter(item => label(item)).slice(0,32);
    return safe;
}
function normalizeEvent(event) {
    if (!event || typeof event !== 'object' || !identifier(event.id) || !KINDS.has(event.kind) || !label(event.action)
        || !Number.isSafeInteger(event.timeMs) || event.timeMs < 0 || event.timeMs > 8640000000000000) throw Object.assign(new Error('invalid_activity_event'), { status: 400 });
    const safe = { id: event.id, timeMs: event.timeMs, kind: event.kind, action: event.action };
    for (const key of ['runId', 'sessionId', 'clientRequestId', 'serverRequestId', 'chatRequestId']) {
        if (event[key] != null && event[key] !== '' && !identifier(event[key])) throw Object.assign(new Error('invalid_activity_id'), { status: 400 });
        safe[key] = identifier(event[key]);
    }
    for (const key of ['page', 'control', 'stage', 'code', 'errorType', 'version', 'model', 'method']) safe[key] = label(event[key]);
    safe.seq = Number.isSafeInteger(event.seq) && event.seq >= 0 ? event.seq : null;
    safe.metrics = {};
    for (const [key, value] of Object.entries(event.metrics || {})) if (NUMBERS.has(key) && Number.isSafeInteger(value) && Math.abs(value) <= 1e12) safe.metrics[key] = value;
    safe.context = clientContext(event.context);
    if (Array.isArray(event.errorFrames)) safe.errorFrames = event.errorFrames.filter(item => label(item)).slice(0,16);
    // Error messages, DOM text, input values, URLs and arbitrary payloads never enter this schema.
    return safe;
}

function createUserActivity({ dbRunAsync: run, dbAllAsync: all, withMainDbTransaction: transaction, startupReady = Promise.resolve() }) {
    const ready = startupReady.then(async () => {
        await run(`CREATE TABLE IF NOT EXISTS user_activity (
            row_id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, event_id TEXT NOT NULL,
            client_time_ms INTEGER NOT NULL, received_time_ms INTEGER NOT NULL, source TEXT NOT NULL,
            kind TEXT NOT NULL, action TEXT NOT NULL, session_id TEXT, session_verified INTEGER NOT NULL,
            client_request_id TEXT, server_request_id TEXT, chat_request_id TEXT, details TEXT NOT NULL,
            UNIQUE(user_id, event_id), FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE)`);
        await run('CREATE INDEX IF NOT EXISTS user_activity_user_time ON user_activity(user_id, received_time_ms, row_id)');
        await run('CREATE INDEX IF NOT EXISTS user_activity_request ON user_activity(server_request_id)');
        await run('CREATE INDEX IF NOT EXISTS user_activity_session ON user_activity(user_id, session_id, row_id)');
        await run('CREATE INDEX IF NOT EXISTS user_activity_retention ON user_activity(received_time_ms)');
        await run('DELETE FROM user_activity WHERE received_time_ms < ?', [Date.now() - RETENTION_MS]);
    });
    let lastPrune = Date.now(), pending = 0;
    async function append(userId, events, source = 'web') {
        await ready;
        const received = Date.now();
        return transaction(async tx => {
            const ownership = new Map();
            for (const event of events) {
                if (!event.sessionId || ownership.has(event.sessionId)) continue;
                const session = await tx.get('SELECT user_id FROM sessions WHERE id = ?', [event.sessionId]);
                if (session && session.user_id !== userId) {
                    if (source !== 'server') throw Object.assign(new Error('activity_session_forbidden'), { status: 403 });
                    for (const candidate of events) if (candidate.sessionId === event.sessionId) { candidate.sessionId = null; candidate.sessionRelation = 'foreign_reference_rejected'; }
                    continue;
                }
                ownership.set(event.sessionId, !!session);
            }
            for (const event of events) await tx.run(`INSERT OR IGNORE INTO user_activity
                (user_id,event_id,client_time_ms,received_time_ms,source,kind,action,session_id,session_verified,client_request_id,server_request_id,chat_request_id,details)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [userId, event.id, event.timeMs, received, source, event.kind, event.action, event.sessionId,
                ownership.get(event.sessionId) ? 1 : 0, event.clientRequestId, event.serverRequestId, event.chatRequestId, JSON.stringify(event)]);
            if (received - lastPrune > 3600000) {
                await tx.run('DELETE FROM user_activity WHERE received_time_ms < ?', [received - RETENTION_MS]);
                lastPrune = received;
            }
        });
    }
    function serverEvent(req, action, fields = {}) {
        try {
        if (!req.user?.userId || req.path === '/api/user/activity' || pending >= 128) return;
        const route = typeof req.route?.path === 'string' ? req.route.path : '';
        const sessionId = req.diagnosticSessionId || req.body?.sessionId || (route.startsWith('/api/sessions/') ? req.params?.sessionId || req.params?.id : null);
        const event = normalizeEvent({ id: crypto.randomUUID(), timeMs: Date.now(), kind: fields.kind || 'http', action,
            sessionId: identifier(sessionId), ...trace(req), ...fields });
        event.context = { ...req.activityClientContext, ...event.context };
        event.network = network(req);
        if (fields.latency) event.latency = fields.latency; // Constructed by chat-latency; contains no payloads.
        pending++;
        append(req.user.userId, [event], 'server').catch(() => {
            console.error(JSON.stringify({ event: 'activity_persist_failed', time: new Date().toISOString(), serverRequestId: req.diagnosticRequestId }));
        }).finally(() => { pending--; });
        } catch (_) { console.error(JSON.stringify({ event: 'activity_metadata_invalid', time: new Date().toISOString() })); }
    }
    function bindRequest(req) {
        let context = {};
        try {
            const header = req.get('X-RAI-Client-Context');
            if (typeof header === 'string' && header.length <= 4096) context = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
        } catch (_) { /* Malformed optional metadata never changes request behavior. */ }
        req.activityClientContext = clientContext(context);
        req.recordUserActivity = (action, fields) => serverEvent(req, action, fields);
    }
    function network(req) {
        const ip = value => typeof value === 'string' && net.isIP(value) ? value : null;
        const ipv4 = value => net.isIP(value || '') === 4 ? value : typeof value === 'string' && value.startsWith('::ffff:') && net.isIP(value.slice(7)) === 4 ? value.slice(7) : null;
        return { clientIp: ip(req.ip), peerIp: ip(req.socket?.remoteAddress),
            clientIpv4: ipv4(req.ip), clientIpv6: net.isIP(req.ip || '') === 6 ? req.ip : null,
            proxyChain: (req.ips || []).filter(value => ip(value)).slice(0,8),
            clientIpVersion: net.isIP(req.ip || '') || null, peerIpVersion: net.isIP(req.socket?.remoteAddress || '') || null };
    }
    function install({ app, authenticateToken, authenticateAdmin }) {
        const limiter = rateLimit({ windowMs: 60000, max: 120, standardHeaders: true, legacyHeaders: false });
        app.post('/api/user/activity', limiter, authenticateToken, async (req, res) => {
            res.setHeader('Cache-Control', 'no-store');
            try {
                if (!Array.isArray(req.body?.events) || !req.body.events.length || req.body.events.length > 50) return res.status(400).json({ error: 'activity_batch_1_to_50' });
                const events = req.body.events.map(normalizeEvent);
                for (const event of events) event.network = network(req);
                await append(req.user.userId, events, req.body.source === 'native' ? 'native' : 'web');
                res.json({ accepted: events.length, receivedTimeMs: Date.now() });
            } catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : 'activity_write_failed' }); }
        });
        app.get('/api/admin/user-activity', limiter, authenticateAdmin, async (req, res) => {
            res.setHeader('Cache-Control', 'no-store');
            try {
                await ready;
                const conditions = ['a.received_time_ms >= ?'], params = [Date.now() - RETENTION_MS];
                for (const [key, column] of [['userId','a.user_id'], ['sessionId','a.session_id']]) {
                    if (req.query[key]) { conditions.push(`${column} = ?`); params.push(String(req.query[key]).slice(0,128)); }
                }
                if (req.query.requestId) { conditions.push('(a.server_request_id = ? OR a.client_request_id = ? OR a.chat_request_id = ?)'); const requestId = String(req.query.requestId).slice(0,128); params.push(requestId, requestId, requestId); }
                if (req.query.account) { conditions.push('(u.username LIKE ? OR u.email LIKE ?)'); const search = '%' + String(req.query.account).slice(0,100) + '%'; params.push(search, search); }
                if (req.query.before) { conditions.push('a.row_id < ?'); params.push(Number(req.query.before) || 0); }
                for (const [key, operator] of [['from','>='], ['to','<=']]) if (req.query[key]) {
                    const time = Date.parse(req.query[key]);
                    if (!Number.isFinite(time)) return res.status(400).json({ error: 'invalid_activity_time' });
                    conditions.push(`a.received_time_ms ${operator} ?`); params.push(time);
                }
                if (req.query.errorsOnly === 'true') conditions.push("(a.kind = 'error' OR a.action IN ('error','incomplete','http_aborted','stream_reasoning_without_answer') OR json_extract(a.details,'$.metrics.status') >= 400 OR json_extract(a.details,'$.latency.outcome') IN ('error','incomplete'))");
                const rows = await all(`SELECT a.*, u.username, u.email FROM user_activity a JOIN users u ON u.id = a.user_id
                    WHERE ${conditions.join(' AND ')} ORDER BY a.row_id DESC LIMIT 201`, params);
                const events = rows.slice(0,200).map(row => ({ ...JSON.parse(row.details), rowId: row.row_id, userId: row.user_id,
                    username: row.username, email: row.email, receivedTimeMs: row.received_time_ms, source: row.source, sessionVerified: !!row.session_verified }));
                res.json({ events, nextBefore: rows.length > 200 ? events.at(-1).rowId : null, retentionDays: 30 });
            } catch (_) { res.status(500).json({ error: 'activity_query_failed' }); }
        });
    }
    return { ready, append, bindRequest, install };
}
module.exports = { createUserActivity, normalizeEvent, clientContext };
