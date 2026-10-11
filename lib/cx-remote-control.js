'use strict';

const crypto = require('node:crypto');
const { createCxRemoteStateStore } = require('./cx-remote-state');
const DEVICE_LEASE_MS = 45000;
const SESSION_MS = 15 * 60 * 1000;
const APPROVAL_MS = 3 * 60 * 1000; // Give the helper time to wake a suspended/closed UWP.
const JOB_MS = 5 * 60 * 1000;
const TOOLS = Object.freeze(['list_files', 'read_file', 'write_file', 'transform_file', 'edit_file', 'create_artifact', 'sandbox_exec', 'copy_file', 'move_file', 'delete_file', 'insert_image', 'update_sheet']);

function failure(code, status = 409) {
    return Object.assign(new Error(code), { code, status });
}
function id(prefix) { return prefix + '_' + crypto.randomBytes(24).toString('base64url'); }
function safeText(value, max) { return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max); }

// Live sessions/jobs are ephemeral. Explicit web-v2 device opt-in and scoped
// permanent consent survive restart, but never credentials, local paths or tool data.
function installCxRemoteRoutes({ app, authenticateToken, apiLimiter, dbGet, isLoginSessionActive, statePath, now = Date.now }) {
    if (typeof isLoginSessionActive !== 'function') throw new TypeError('CX remote requires an active-login verifier');
    const devices = new Map(), sessions = new Map(), jobs = new Map(), grants = new Map();
    const store = createCxRemoteStateStore(statePath);
    let persistenceFault = false;
    const hash = value => crypto.createHash('sha256').update(String(value || '')).digest();
    const grantKey = s => JSON.stringify([s.userId, s.authSessionId, s.deviceId, s.conversationId, s.rootId]);
    const grantFor = s => s.authorizationProtocol === 'web-v2' && s.rootId ? grants.get(grantKey(s)) : null;
    try {
        const saved = store.load();
        for (const d of saved.devices) devices.set(d.id, { ...d, lastSeen: 0, runtime: 'offline' });
        for (const g of saved.grants) grants.set(grantKey(g), g);
    } catch { persistenceFault = true; }
    function persist() {
        try {
            store.save({ schema: 'rai.cx-remote-consent.v1',
                devices: [...devices.values()].filter(d => d.authorizationProtocol === 'web-v2').map(d => ({
                    id: d.id, userId: d.userId, secretHash: d.secretHash, installationHash: d.installationHash,
                    authorizationProtocol: d.authorizationProtocol, name: d.name, version: d.version
                })),
                grants: [...grants.values()].map(g => ({ id: g.id, userId: g.userId, authSessionId: g.authSessionId,
                    deviceId: g.deviceId, conversationId: g.conversationId, rootId: g.rootId, createdAt: g.createdAt }))
            });
        } catch {
            persistenceFault = true;
            for (const session of [...sessions.values()]) revokeSession(session);
            throw failure('cx_remote_state_unavailable', 503);
        }
    }
    function requireHealthy() { if (persistenceFault) throw failure('cx_remote_state_unavailable', 503); }
    function deleteGrants(predicate) {
        let changed = false;
        for (const [key, g] of grants) if (predicate(g)) { grants.delete(key); changed = true; }
        return changed;
    }
    const online = d => !!d && d.lastSeen > now() - DEVICE_LEASE_MS;
    const publicDevice = d => ({
        id: d.id, name: d.name, version: d.version, online: online(d), platform: 'windows',
        capabilities: TOOLS, runtime: d.runtime || 'uwp', lastSeenAt: d.lastSeen,
        authorizationProtocol: d.authorizationProtocol || 'local-v1'
    });
    function publicSession(s) {
        const d = devices.get(s.deviceId);
        return {
            id: s.id, conversationId: s.conversationId, status: s.status, expiresAt: s.expires,
            approvalExpiresAt: s.approvalExpires, confirmationCode: s.code,
            deviceId: s.deviceId, deviceName: d?.name || 'CX RAI PC', online: online(d),
            authorizationProtocol: s.authorizationProtocol || 'local-v1', rootId: s.rootId || '', rootLabel: s.rootLabel || '',
            authorizationMode: grantFor(s) ? 'persistent' : 'ask'
        };
    }
    function revokeSession(s) {
        s.status = 'revoked';
        sessions.delete(s.id);
        for (const j of jobs.values()) {
            if (j.sessionId === s.id) j.resolve?.({ success: false, error: 'cx_remote_connection_revoked' });
        }
    }
    function removeDevice(d) {
        for (const s of sessions.values()) if (s.deviceId === d.id) revokeSession(s);
        devices.delete(d.id);
        const changed = deleteGrants(g => g.deviceId === d.id);
        if (changed || d.authorizationProtocol === 'web-v2') persist();
    }
    function prune() {
        for (const [key, j] of jobs) {
            if (j.expires <= now()) {
                j.resolve?.({ success: false, error: 'cx_remote_task_expired' });
                jobs.delete(key);
            }
        }
        for (const s of sessions.values()) {
            if (s.expires <= now() || (s.status === 'pending' && s.approvalExpires <= now())) revokeSession(s);
        }
        for (const d of devices.values()) if (!online(d)) {
            if (d.authorizationProtocol === 'web-v2') {
                for (const session of [...sessions.values()]) if (session.deviceId === d.id) revokeSession(session);
            } else removeDevice(d);
        }
    }
    function ownSession(userId, sessionId, conversationId) {
        requireHealthy();
        prune();
        const s = sessions.get(sessionId);
        if (!s || s.userId !== userId || ['revoked', 'rejected'].includes(s.status)) throw failure('cx_remote_session_unavailable', 403);
        if (conversationId !== undefined && s.conversationId !== conversationId) throw failure('cx_remote_conversation_mismatch', 403);
        return s;
    }
    async function validateInitiator(s) {
        if (!await isLoginSessionActive(s.userId, s.authSessionId)) {
            revokeLoginSessions(s.userId, s.authSessionId);
            throw failure('cx_remote_requester_signed_out', 403);
        }
        // The database check yields: revocation may have happened while it was pending.
        return ownSession(s.userId, s.id, s.conversationId);
    }
    function revokeLoginSessions(userId, authSessionId) {
        for (const s of sessions.values()) {
            if (s.userId === userId && (authSessionId === undefined || s.authSessionId === authSessionId)) revokeSession(s);
        }
        if (deleteGrants(g => g.userId === userId && (authSessionId === undefined || g.authSessionId === authSessionId))) persist();
    }
    async function validateDeviceSessions(d) {
        for (const s of [...sessions.values()]) {
            if (s.deviceId !== d.id) continue;
            try { await validateInitiator(s); }
            catch (error) { if (error.status !== 403) throw error; }
        }
    }
    function nativeDevice(req) {
        if (!req.softwareClient) throw failure('software_client_key_required', 403);
        const d = devices.get(req.params.deviceId);
        if (!d || d.userId !== req.user.userId || !crypto.timingSafeEqual(Buffer.from(d.secretHash, 'hex'), hash(req.get('X-CX-Device-Key')))) throw failure('cx_remote_device_unavailable', 403);
        return d;
    }
    async function ownedConversation(userId, value) {
        const conversationId = typeof value === 'string' ? value.slice(0, 200) : '';
        if (!conversationId || !await dbGet('SELECT id FROM sessions WHERE id = ? AND user_id = ?', [conversationId, userId])) {
            throw failure('cx_remote_conversation_unavailable', 404);
        }
        return conversationId;
    }
    function pendingFor(d) {
        const own = [...sessions.values()].filter(s => s.deviceId === d.id && !['rejected', 'revoked'].includes(s.status));
        return {
            own,
            approvals: own.filter(s => s.status === 'pending'),
            queued: [...jobs.values()].filter(j => j.deviceId === d.id && j.status === 'queued')
        };
    }
    function endpoint(fn) {
        return async (req, res) => {
            res.set('Cache-Control', 'no-store');
            try { requireHealthy(); prune(); await fn(req, res); }
            catch (e) { res.status(e.status || 500).json({ success: false, error: e.code || 'cx_remote_failed' }); }
        };
    }
    const route = (method, path, fn) => app[method](path, apiLimiter, authenticateToken, endpoint(fn));

    route('post', '/api/cx-remote/devices', async (req, res) => {
        if (!req.softwareClient) throw failure('software_client_key_required', 403);
        if (req.body.platform !== 'windows') throw failure('cx_remote_desktop_only', 400);
        if (req.body.authorizationProtocol !== undefined && !['local-v1', 'web-v2'].includes(req.body.authorizationProtocol)) throw failure('cx_remote_authorization_protocol_invalid', 400);
        const authorizationProtocol = req.body.authorizationProtocol || 'local-v1';
        const installationId = req.body.installationId;
        if (authorizationProtocol === 'web-v2' && !installationId) throw failure('cx_remote_installation_required', 400);
        if (installationId !== undefined && (typeof installationId !== 'string' || !/^[a-zA-Z0-9_-]{32,128}$/.test(installationId))) throw failure('cx_remote_installation_invalid', 400);
        // Normalize caller-controlled fields before mutating durable state. An empty
        // sanitized name is not a disk failure and must never disable other users.
        const name = safeText(req.body.name, 80).trim() || 'CX RAI PC';
        const version = safeText(req.body.version, 30);
        // Deduplicate helper/UWP recovery; installation ids are random, never hardware identifiers.
        const installationHash = installationId ? hash(installationId).toString('hex') : '';
        const old = installationHash && [...devices.values()].find(d => d.userId === req.user.userId && d.installationHash === installationHash);
        if (!old && (devices.size >= 256 || [...devices.values()].filter(d => d.userId === req.user.userId).length >= 5)) throw failure('cx_remote_device_limit', 429);
        if (old) removeDevice(old);
        const secret = crypto.randomBytes(32).toString('base64url');
        const d = {
            id: old?.id || id('cx'), secretHash: hash(secret).toString('hex'), authorizationProtocol,
            userId: req.user.userId, name, version, installationHash, lastSeen: now(), runtime: 'uwp'
        };
        devices.set(d.id, d);
        if (authorizationProtocol === 'web-v2') persist();
        res.json({ success: true, device: { ...publicDevice(d), deviceKey: secret }, heartbeatIntervalMs: 10000 });
    });
    route('get', '/api/cx-remote/devices', async (req, res) => {
        res.json({ success: true, devices: [...devices.values()].filter(d => d.userId === req.user.userId).map(publicDevice) });
    });
    route('delete', '/api/cx-remote/devices/:deviceId', async (req, res) => {
        const d = devices.get(req.params.deviceId);
        if (!d || d.userId !== req.user.userId) throw failure('cx_remote_device_unavailable', 404);
        if (req.softwareClient) nativeDevice(req);
        removeDevice(d);
        res.json({ success: true });
    });
    route('post', '/api/cx-remote/devices/:deviceId/heartbeat', async (req, res) => {
        const d = nativeDevice(req);
        d.lastSeen = now();
        d.runtime = req.body.runtime === 'helper' ? 'helper' : 'uwp';
        await validateDeviceSessions(d);
        if (devices.get(d.id) !== d) throw failure('cx_remote_device_unavailable', 403);
        const pending = pendingFor(d);
        // A heartbeat must NEVER dequeue work; only the UWP approval/execution owner polls.
        res.json({
            success: true, device: publicDevice(d), requiresAttention: pending.approvals.length + pending.queued.length > 0,
            pendingApprovals: pending.approvals.length, pendingTasks: pending.queued.length,
            activeSessionIds: pending.own.filter(s => s.status === 'approved').map(s => s.id),
            heartbeatIntervalMs: 10000
        });
    });
    route('post', '/api/cx-remote/sessions', async (req, res) => {
        if (!req.user.sid) throw failure('cx_remote_login_session_required', 403);
        const d = devices.get(req.body.deviceId);
        if (!d || d.userId !== req.user.userId) throw failure('cx_remote_device_unavailable', 404);
        const conversationId = await ownedConversation(req.user.userId, req.body.conversationId);
        // dbGet yields: repeat lease/ownership validation before issuing any session.
        prune();
        if (devices.get(d.id) !== d || !online(d)) throw failure('cx_remote_device_unavailable', 404);
        const existing = [...sessions.values()].find(s => s.userId === req.user.userId && s.authSessionId === req.user.sid && s.deviceId === d.id && s.conversationId === conversationId && ['pending', 'approved'].includes(s.status));
        if (existing) return res.json({ success: true, session: publicSession(existing) });
        if (sessions.size >= 2048 || [...sessions.values()].filter(s => s.userId === req.user.userId).length >= 8) throw failure('cx_remote_session_limit', 429);
        const s = {
            id: id('cxs'), deviceId: d.id, userId: req.user.userId, authSessionId: req.user.sid, conversationId,
            authorizationProtocol: d.authorizationProtocol || 'local-v1',
            status: 'pending', expires: now() + SESSION_MS, approvalExpires: now() + APPROVAL_MS,
            code: crypto.randomBytes(3).toString('hex').toUpperCase(), requester: safeText(req.get('User-Agent') || 'Web', 180)
        };
        sessions.set(s.id, s);
        res.json({ success: true, session: publicSession(s) });
    });
    route('get', '/api/cx-remote/sessions', async (req, res) => {
        const conversationId = await ownedConversation(req.user.userId, req.query.conversationId);
        prune();
        res.json({ success: true, sessions: [...sessions.values()].filter(s => s.userId === req.user.userId && s.authSessionId === req.user.sid && s.conversationId === conversationId && ['pending', 'approved'].includes(s.status)).map(publicSession) });
    });
    route('get', '/api/cx-remote/sessions/:sessionId', async (req, res) => {
        const session = ownSession(req.user.userId, req.params.sessionId);
        if (session.authSessionId !== req.user.sid) throw failure('cx_remote_login_session_mismatch', 403);
        await validateInitiator(session);
        if (session.authorizationProtocol === 'web-v2' && session.status === 'approved') session.expires = now() + SESSION_MS;
        res.json({ success: true, session: publicSession(session) });
    });
    route('delete', '/api/cx-remote/sessions/:sessionId', async (req, res) => {
        const session = ownSession(req.user.userId, req.params.sessionId);
        if (session.authSessionId !== req.user.sid) throw failure('cx_remote_login_session_mismatch', 403);
        revokeSession(session);
        res.json({ success: true });
    });
    route('get', '/api/cx-remote/devices/:deviceId/poll', async (req, res) => {
        const d = nativeDevice(req);
        d.lastSeen = now(); d.runtime = 'uwp';
        await validateDeviceSessions(d);
        if (devices.get(d.id) !== d) throw failure('cx_remote_device_unavailable', 403);
        const pending = pendingFor(d);
        const approvals = pending.approvals.map(s => ({
            id: s.id, conversationId: s.conversationId, code: s.code, expiresAt: s.approvalExpires,
            requester: s.requester, deviceName: d.name, authorizationProtocol: s.authorizationProtocol
        }));
        const tasks = [];
        const task = pending.queued[0];
        if (task && req.query.busy !== '1' && approvals.length === 0) {
            task.status = 'delivered';
            tasks.push({
                id: task.id, sessionId: task.sessionId, conversationId: task.conversationId,
                tool: task.tool, parameters: task.parameters, expiresAt: task.expires,
                confirmationCode: sessions.get(task.sessionId)?.code,
                ...(task.authorization ? { authorization: { ...task.authorization } } : {})
            });
        }
        res.json({
            success: true, approvals, tasks,
            activeSessionIds: pending.own.filter(s => s.status === 'approved').map(s => s.id),
            activeJobIds: [...jobs.values()].filter(j => j.deviceId === d.id).map(j => j.id)
        });
    });
    route('post', '/api/cx-remote/devices/:deviceId/approve', async (req, res) => {
        const d = nativeDevice(req), s = ownSession(req.user.userId, req.body.sessionId);
        await validateInitiator(s);
        if (s.deviceId !== d.id || s.status !== 'pending') throw failure('cx_remote_approval_unavailable');
        if (req.body.approved === true && s.authorizationProtocol === 'web-v2') {
            if (req.body.authorizationProtocol !== 'web-v2' || !/^[a-f0-9]{64}$/.test(req.body.rootId)
                || typeof req.body.rootLabel !== 'string' || !req.body.rootLabel.trim() || req.body.rootLabel.length > 1024) {
                throw failure('cx_remote_root_preparation_required', 400);
            }
            const rootLabel = safeText(req.body.rootLabel, 1024);
            if (!rootLabel.trim()) throw failure('cx_remote_root_preparation_required', 400);
            s.rootId = req.body.rootId; s.rootLabel = rootLabel;
        }
        s.status = req.body.approved === true ? 'approved' : 'rejected';
        if (s.status === 'approved') s.expires = now() + SESSION_MS;
        else sessions.delete(s.id);
        res.json({ success: true });
    });
    function authorizeJob(j, s, mode, grant) {
        j.authorization = { protocol: 'web-v2', source: 'web', mode, rootId: s.rootId, decisionId: id('cxa') };
        j.grantId = grant?.id || null; j.status = 'queued';
    }
    async function webSession(req) {
        const s = ownSession(req.user.userId, req.params.sessionId);
        if (s.authSessionId !== req.user.sid) throw failure('cx_remote_login_session_mismatch', 403);
        await validateInitiator(s);
        if (s.authorizationProtocol !== 'web-v2') throw failure('cx_remote_web_authorization_not_enabled', 409);
        if (s.status !== 'approved' || !s.rootId) throw failure('cx_remote_root_preparation_required', 409);
        s.expires = now() + SESSION_MS;
        return s;
    }
    function publicGrant(s) {
        const grant = grantFor(s);
        return { mode: grant ? 'persistent' : 'ask', rootId: s.rootId, rootLabel: s.rootLabel,
            scope: 'login-device-conversation-root', ...(grant ? { createdAt: grant.createdAt } : {}) };
    }
    async function pruneUserGrants(userId) {
        const candidates = [...grants.values()].filter(g => g.userId === userId);
        const sessionsToCheck = [...new Set(candidates.map(g => g.authSessionId))];
        let changed = false;
        for (const sid of sessionsToCheck) {
            if (!await isLoginSessionActive(userId, sid)) {
                changed = deleteGrants(g => g.userId === userId && g.authSessionId === sid) || changed;
                for (const session of [...sessions.values()]) if (session.userId === userId && session.authSessionId === sid) revokeSession(session);
            }
        }
        if (changed) persist();
    }
    route('get', '/api/cx-remote/sessions/:sessionId/authorizations', async (req, res) => {
        const s = await webSession(req);
        const pending = [...jobs.values()].filter(j => j.sessionId === s.id && j.status === 'awaiting_web');
        res.json({ success: true, grant: publicGrant(s), jobs: pending.map(j => ({
            id: j.id, tool: j.tool, parameters: j.parameters, expiresAt: j.expires, status: j.status,
            rootId: s.rootId, rootLabel: s.rootLabel, deviceName: devices.get(s.deviceId)?.name,
            conversationId: s.conversationId
        })) });
    });
    route('post', '/api/cx-remote/sessions/:sessionId/authorizations/:jobId', async (req, res) => {
        const decision = req.body.decision;
        if (!['once', 'persistent', 'reject'].includes(decision)) throw failure('cx_remote_decision_invalid', 400);
        const s = await webSession(req);
        if (decision === 'persistent') { await pruneUserGrants(s.userId); await validateInitiator(s); }
        const j = jobs.get(req.params.jobId);
        if (!j || j.sessionId !== s.id || j.status !== 'awaiting_web') throw failure('cx_remote_task_unavailable', 409);
        if (decision === 'reject') j.resolve?.({ success: false, error: 'user_rejected_remote_action' });
        else {
            let grant;
            if (decision === 'persistent') {
                grant = grantFor(s);
                if (!grant) {
                    if (grants.size >= 2048 || [...grants.values()].filter(g => g.userId === s.userId).length >= 64) throw failure('cx_remote_grant_limit', 429);
                    grant = { id: id('cxg'), userId: s.userId, authSessionId: s.authSessionId, deviceId: s.deviceId,
                        conversationId: s.conversationId, rootId: s.rootId, createdAt: now() };
                    grants.set(grantKey(grant), grant); persist();
                }
            }
            authorizeJob(j, s, decision, grant);
        }
        res.json({ success: true, decision, grant: publicGrant(s) });
    });
    function revokeGrantScope(key) {
        grants.delete(key);
        // Native receives cancellation via activeJobIds. This cannot undo effects
        // and does not claim that local cancellation has already completed.
        for (const j of [...jobs.values()]) {
            const owner = sessions.get(j.sessionId);
            if (owner && grantKey(owner) === key) j.resolve?.({ success: false, error: 'cx_remote_grant_revoked' });
        }
        persist();
    }
    async function requireWebLogin(req) {
        if (!req.user.sid) throw failure('cx_remote_login_session_required', 403);
        if (!await isLoginSessionActive(req.user.userId, req.user.sid)) {
            revokeLoginSessions(req.user.userId, req.user.sid);
            throw failure('cx_remote_requester_signed_out', 403);
        }
        requireHealthy();
    }
    // Consent management must work while the PC is offline and after a session
    // or server restart. Neither endpoint requires a live connection/directory.
    route('get', '/api/cx-remote/grants', async (req, res) => {
        const conversationId = req.query.conversationId === undefined ? undefined : await ownedConversation(req.user.userId, req.query.conversationId);
        await requireWebLogin(req);
        const own = [...grants.values()].filter(g => g.userId === req.user.userId && g.authSessionId === req.user.sid && (conversationId === undefined || g.conversationId === conversationId));
        res.json({ success: true, grants: own.map(g => ({
            id: g.id, deviceId: g.deviceId, deviceName: devices.get(g.deviceId)?.name || 'CX RAI PC',
            conversationId: g.conversationId, rootId: g.rootId,
            rootLabel: [...sessions.values()].find(s => grantKey(s) === grantKey(g))?.rootLabel || '',
            createdAt: g.createdAt, scope: 'login-device-conversation-root'
        })) });
    });
    route('delete', '/api/cx-remote/grants/:grantId', async (req, res) => {
        await requireWebLogin(req);
        const grant = [...grants.values()].find(g => g.id === req.params.grantId && g.userId === req.user.userId && g.authSessionId === req.user.sid);
        if (!grant) throw failure('cx_remote_grant_unavailable', 404);
        revokeGrantScope(grantKey(grant));
        res.json({ success: true });
    });
    route('delete', '/api/cx-remote/sessions/:sessionId/grant', async (req, res) => {
        const s = await webSession(req);
        revokeGrantScope(grantKey(s));
        res.json({ success: true, grant: publicGrant(s) });
    });
    route('post', '/api/cx-remote/devices/:deviceId/tasks/:jobId/start', async (req, res) => {
        const d = nativeDevice(req), j = jobs.get(req.params.jobId);
        if (!j || j.deviceId !== d.id || j.status !== 'delivered') throw failure('cx_remote_task_unavailable');
        const s = ownSession(req.user.userId, j.sessionId, j.conversationId);
        await validateInitiator(s);
        if (!jobs.has(j.id) || j.status !== 'delivered') throw failure('cx_remote_task_unavailable');
        if (s.status !== 'approved') throw failure('cx_remote_connection_not_approved', 403);
        if (s.authorizationProtocol === 'web-v2') {
            if (!j.authorization || req.body.authorizationProtocol !== 'web-v2'
                || req.body.rootId !== s.rootId || req.body.rootId !== j.authorization.rootId
                || req.body.decisionId !== j.authorization.decisionId) throw failure('cx_remote_web_authorization_required', 403);
            if (j.authorization.mode === 'persistent' && grantFor(s)?.id !== j.grantId) throw failure('cx_remote_grant_revoked', 403);
        }
        j.status = 'running';
        res.json({ success: true, ...(j.authorization ? { authorization: { ...j.authorization } } : {}) });
    });
    route('post', '/api/cx-remote/devices/:deviceId/tasks/:jobId/result', async (req, res) => {
        const d = nativeDevice(req), j = jobs.get(req.params.jobId);
        if (!j || j.deviceId !== d.id || !['delivered', 'running'].includes(j.status)) throw failure('cx_remote_task_unavailable');
        await validateInitiator(ownSession(req.user.userId, j.sessionId, j.conversationId));
        if (jobs.get(j.id) !== j || !['delivered', 'running'].includes(j.status)) throw failure('cx_remote_task_unavailable');
        const result = req.body.result;
        if (!result || typeof result !== 'object' || Array.isArray(result)) throw failure('cx_remote_result_invalid', 400);
        if (j.status === 'delivered' && result.success !== false) throw failure('cx_remote_start_required', 403);
        if (Buffer.byteLength(JSON.stringify(result)) > 128 * 1024) throw failure('cx_remote_result_too_large', 413);
        j.status = 'completed'; j.resolve?.(result);
        res.json({ success: true });
    });
    function resolveChatSession(userId, input, conversationId, authSessionId) {
        if (!input || input.protocolVersion !== 'cx-online-v1') return null;
        const s = ownSession(userId, input.sessionId, conversationId);
        if (authSessionId !== undefined && s.authSessionId !== authSessionId) throw failure('cx_remote_login_session_mismatch', 403);
        if (s.status !== 'approved') throw failure('cx_remote_connection_not_approved', 403);
        return { ...s, platform: 'windows' };
    }
    async function execute(userId, sessionId, conversationId, tool, parameters, signal) {
        const s = ownSession(userId, sessionId, conversationId);
        const parameterJson = JSON.stringify(parameters || {});
        if (Buffer.byteLength(parameterJson) > 64 * 1024) throw failure('cx_remote_parameters_too_large', 413);
        const parametersCopy = JSON.parse(parameterJson); // Freeze before the first async boundary.
        await validateInitiator(s);
        if (s.status !== 'approved') throw failure('cx_remote_connection_not_approved', 403);
        if (!TOOLS.includes(tool)) throw failure('cx_remote_tool_not_supported', 400);
        if (signal?.aborted) throw failure('cx_remote_request_cancelled');
        if (jobs.size >= 256) throw failure('cx_remote_job_limit', 429);
        if ([...jobs.values()].some(j => j.deviceId === s.deviceId && !['completed', 'cancelled'].includes(j.status))) throw failure('cx_remote_device_busy', 409);
        const j = { id: id('cxj'), deviceId: s.deviceId, userId, sessionId: s.id, conversationId, tool, parameters: parametersCopy, status: 'queued', expires: now() + JOB_MS };
        if (s.authorizationProtocol === 'web-v2') {
            if (!s.rootId) throw failure('cx_remote_root_preparation_required', 403);
            const grant = grantFor(s);
            if (grant) authorizeJob(j, s, 'persistent', grant);
            else j.status = 'awaiting_web';
        }
        jobs.set(j.id, j);
        return new Promise(resolve => {
            const timer = setTimeout(() => finish({ success: false, error: 'cx_remote_task_expired' }), JOB_MS);
            const abort = () => finish({ success: false, error: 'cx_remote_request_cancelled' });
            function finish(value) {
                if (!jobs.has(j.id)) return;
                clearTimeout(timer); signal?.removeEventListener('abort', abort);
                if (j.status === 'running') value = { ...value, executed: 'unknown', retryable: false, message: 'The PC may already have executed this operation. Cancellation was requested, not confirmed. Check the PC state before explicitly starting a new request; do not automatically retry.' };
                if (j.status !== 'completed') j.status = 'cancelled';
                j.resolve = null; j.parameters = {}; jobs.delete(j.id); resolve(value);
            }
            j.resolve = finish; signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) abort();
        });
    }
    // Offline devices lose live sessions/jobs; only v2 opt-in identities remain reconnectable.
    const sweep = setInterval(prune, 5000);
    sweep.unref?.();
    function close() {
        clearInterval(sweep);
        for (const s of sessions.values()) revokeSession(s);
        devices.clear();
    }
    return { resolveChatSession, execute, devices, sessions, jobs, grants, prune, close, revokeLoginSessions };
}
module.exports = { installCxRemoteRoutes, TOOLS, DEVICE_LEASE_MS, SESSION_MS, APPROVAL_MS };
