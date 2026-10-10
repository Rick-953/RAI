'use strict';

const crypto = require('node:crypto');
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

// Deliberately ephemeral: a server restart requires new registration and local approval.
// Neither account credentials, file contents nor local paths are persisted here.
function installCxRemoteRoutes({ app, authenticateToken, apiLimiter, dbGet, isLoginSessionActive, now = Date.now }) {
    if (typeof isLoginSessionActive !== 'function') throw new TypeError('CX remote requires an active-login verifier');
    const devices = new Map(), sessions = new Map(), jobs = new Map();
    const hash = value => crypto.createHash('sha256').update(String(value || '')).digest();
    const same = (a, b) => crypto.timingSafeEqual(hash(a), hash(b));
    const online = d => !!d && d.lastSeen > now() - DEVICE_LEASE_MS;
    const publicDevice = d => ({
        id: d.id, name: d.name, version: d.version, online: online(d), platform: 'windows',
        capabilities: TOOLS, runtime: d.runtime || 'uwp', lastSeenAt: d.lastSeen
    });
    function publicSession(s) {
        const d = devices.get(s.deviceId);
        return {
            id: s.id, conversationId: s.conversationId, status: s.status, expiresAt: s.expires,
            approvalExpiresAt: s.approvalExpires, confirmationCode: s.code,
            deviceId: s.deviceId, deviceName: d?.name || 'CX RAI PC', online: online(d)
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
        for (const d of devices.values()) if (!online(d)) removeDevice(d);
    }
    function ownSession(userId, sessionId, conversationId) {
        prune();
        const s = sessions.get(sessionId);
        if (!s || s.userId !== userId || ['revoked', 'rejected'].includes(s.status)) throw failure('cx_remote_session_unavailable', 403);
        if (conversationId !== undefined && s.conversationId !== conversationId) throw failure('cx_remote_conversation_mismatch', 403);
        return s;
    }
    async function validateInitiator(s) {
        if (!await isLoginSessionActive(s.userId, s.authSessionId)) {
            revokeSession(s);
            throw failure('cx_remote_requester_signed_out', 403);
        }
        // The database check yields: revocation may have happened while it was pending.
        return ownSession(s.userId, s.id, s.conversationId);
    }
    function revokeLoginSessions(userId, authSessionId) {
        for (const s of sessions.values()) {
            if (s.userId === userId && (authSessionId === undefined || s.authSessionId === authSessionId)) revokeSession(s);
        }
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
        if (!d || d.userId !== req.user.userId || !same(d.secret, req.get('X-CX-Device-Key'))) throw failure('cx_remote_device_unavailable', 403);
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
            try { prune(); await fn(req, res); }
            catch (e) { res.status(e.status || 500).json({ success: false, error: e.code || 'cx_remote_failed' }); }
        };
    }
    const route = (method, path, fn) => app[method](path, apiLimiter, authenticateToken, endpoint(fn));

    route('post', '/api/cx-remote/devices', async (req, res) => {
        if (!req.softwareClient) throw failure('software_client_key_required', 403);
        if (req.body.platform !== 'windows') throw failure('cx_remote_desktop_only', 400);
        const installationId = req.body.installationId;
        if (installationId !== undefined && (typeof installationId !== 'string' || !/^[a-zA-Z0-9_-]{32,128}$/.test(installationId))) throw failure('cx_remote_installation_invalid', 400);
        // Deduplicate helper/UWP recovery; installation ids are random, never hardware identifiers.
        const installationHash = installationId ? hash(installationId).toString('hex') : '';
        const old = installationHash && [...devices.values()].find(d => d.userId === req.user.userId && d.installationHash === installationHash);
        if (!old && (devices.size >= 256 || [...devices.values()].filter(d => d.userId === req.user.userId).length >= 5)) throw failure('cx_remote_device_limit', 429);
        if (old) removeDevice(old);
        const d = {
            id: old?.id || id('cx'), secret: crypto.randomBytes(32).toString('base64url'),
            userId: req.user.userId, name: safeText(req.body.name || 'CX RAI PC', 80),
            version: safeText(req.body.version, 30), installationHash, lastSeen: now(), runtime: 'uwp'
        };
        devices.set(d.id, d);
        res.json({ success: true, device: { ...publicDevice(d), deviceKey: d.secret }, heartbeatIntervalMs: 10000 });
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
        if (devices.get(d.id) !== d) throw failure('cx_remote_device_unavailable', 404);
        const existing = [...sessions.values()].find(s => s.userId === req.user.userId && s.authSessionId === req.user.sid && s.deviceId === d.id && s.conversationId === conversationId && ['pending', 'approved'].includes(s.status));
        if (existing) return res.json({ success: true, session: publicSession(existing) });
        if (sessions.size >= 2048 || [...sessions.values()].filter(s => s.userId === req.user.userId).length >= 8) throw failure('cx_remote_session_limit', 429);
        const s = {
            id: id('cxs'), deviceId: d.id, userId: req.user.userId, authSessionId: req.user.sid, conversationId,
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
        res.json({ success: true, session: publicSession(session) });
    });
    route('delete', '/api/cx-remote/sessions/:sessionId', async (req, res) => {
        revokeSession(ownSession(req.user.userId, req.params.sessionId));
        res.json({ success: true });
    });
    route('get', '/api/cx-remote/devices/:deviceId/poll', async (req, res) => {
        const d = nativeDevice(req);
        d.lastSeen = now(); d.runtime = 'uwp';
        const pending = pendingFor(d);
        const approvals = pending.approvals.map(s => ({
            id: s.id, conversationId: s.conversationId, code: s.code, expiresAt: s.approvalExpires,
            requester: s.requester, deviceName: d.name
        }));
        const tasks = [];
        const task = pending.queued[0];
        if (task && req.query.busy !== '1' && approvals.length === 0) {
            task.status = 'delivered';
            tasks.push({
                id: task.id, sessionId: task.sessionId, conversationId: task.conversationId,
                tool: task.tool, parameters: task.parameters, expiresAt: task.expires,
                confirmationCode: sessions.get(task.sessionId)?.code
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
        s.status = req.body.approved === true ? 'approved' : 'rejected';
        if (s.status === 'approved') s.expires = now() + SESSION_MS;
        else sessions.delete(s.id);
        res.json({ success: true });
    });
    route('post', '/api/cx-remote/devices/:deviceId/tasks/:jobId/start', async (req, res) => {
        const d = nativeDevice(req), j = jobs.get(req.params.jobId);
        if (!j || j.deviceId !== d.id || j.status !== 'delivered') throw failure('cx_remote_task_unavailable');
        const s = ownSession(req.user.userId, j.sessionId, j.conversationId);
        await validateInitiator(s);
        if (!jobs.has(j.id) || j.status !== 'delivered') throw failure('cx_remote_task_unavailable');
        if (s.status !== 'approved') throw failure('cx_remote_connection_not_approved', 403);
        j.status = 'running';
        res.json({ success: true });
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
        await validateInitiator(s);
        if (s.status !== 'approved') throw failure('cx_remote_connection_not_approved', 403);
        if (!TOOLS.includes(tool)) throw failure('cx_remote_tool_not_supported', 400);
        if (signal?.aborted) throw failure('cx_remote_request_cancelled');
        if (Buffer.byteLength(JSON.stringify(parameters || {})) > 64 * 1024) throw failure('cx_remote_parameters_too_large', 413);
        if (jobs.size >= 256) throw failure('cx_remote_job_limit', 429);
        if ([...jobs.values()].some(j => j.deviceId === s.deviceId && !['completed', 'cancelled'].includes(j.status))) throw failure('cx_remote_device_busy', 409);
        const j = { id: id('cxj'), deviceId: s.deviceId, userId, sessionId: s.id, conversationId, tool, parameters, status: 'queued', expires: now() + JOB_MS };
        jobs.set(j.id, j);
        return new Promise(resolve => {
            const timer = setTimeout(() => finish({ success: false, error: 'cx_remote_task_expired' }), JOB_MS);
            const abort = () => finish({ success: false, error: 'cx_remote_request_cancelled' });
            function finish(value) {
                if (!jobs.has(j.id)) return;
                clearTimeout(timer); signal?.removeEventListener('abort', abort);
                if (j.status !== 'completed') j.status = 'cancelled';
                j.resolve = null; j.parameters = {}; jobs.delete(j.id); resolve(value);
            }
            j.resolve = finish; signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) abort();
        });
    }
    // A disappeared device is revoked even when no browser happens to poll it.
    const sweep = setInterval(prune, 5000);
    sweep.unref?.();
    function close() {
        clearInterval(sweep);
        for (const s of sessions.values()) revokeSession(s);
        devices.clear();
    }
    return { resolveChatSession, execute, devices, sessions, jobs, prune, close, revokeLoginSessions };
}
module.exports = { installCxRemoteRoutes, TOOLS, DEVICE_LEASE_MS, SESSION_MS, APPROVAL_MS };
