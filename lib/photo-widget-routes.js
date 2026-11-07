'use strict';

// 照片桌面小组件 HTTP 路由：前缀 /api/photo-widget，全部需要 Bearer 认证。
// 安装方式照 lib/secure-sharing-routes.js：不碰 monolith 内部，只依赖宿主传入的 db/auth/limiter。

const { createPhotoWidgetService } = require('./photo-widget');

const SEARCH_MAX_LENGTH = 100;
const MAX_WAIT_SECONDS = 25;

function installPhotoWidgetRoutes({
    app,
    authenticateToken,
    apiLimiter,
    dbRunAsync,
    dbGetAsync,
    dbAllAsync,
    now = () => Date.now()
} = {}) {
    if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
        throw new TypeError('an express app is required');
    }
    for (const [name, value] of Object.entries({ authenticateToken, apiLimiter, dbRunAsync, dbGetAsync, dbAllAsync })) {
        if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
    }

    const service = createPhotoWidgetService({ dbRunAsync, dbGetAsync, dbAllAsync, now });
    const ready = service.migrate();
    ready.catch(() => undefined); // 每个请求的 wrap 会再 await 并把错误映射成 500

    const fail = (code, statusCode) => {
        throw Object.assign(new Error(code), { code, statusCode });
    };

    const wrap = (handler) => async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Referrer-Policy', 'no-referrer');
        try {
            await ready;
            await handler(req, res);
        } catch (error) {
            if (res.headersSent) return;
            const statusCode = Number(error && error.statusCode) || 500;
            const code = statusCode >= 500 ? 'internal_error' : String((error && error.code) || 'request_failed');
            if (statusCode >= 500) console.error(' photo-widget 路由失败:', code);
            res.status(statusCode).json({ success: false, error: code });
        }
    };

    const currentUserId = (req) => {
        const userId = Number(req.user && req.user.userId);
        return Number.isSafeInteger(userId) && userId > 0 ? userId : null;
    };

    const requireUserId = (req) => {
        const userId = currentUserId(req);
        if (userId === null) fail('unauthorized', 401);
        return userId;
    };

    // 接受 JSON 数字或纯数字字符串；其余（布尔、数组、小数、负数）一律视为缺失。
    function parseInteger(value, minimum) {
        if (typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum) return value;
        if (typeof value === 'string' && /^\d{1,16}$/.test(value)) {
            const parsed = Number(value);
            if (Number.isSafeInteger(parsed) && parsed >= minimum) return parsed;
        }
        return null;
    }

    function parseWaitSeconds(value) {
        if (value === undefined || value === null || value === '') return MAX_WAIT_SECONDS;
        const parsed = typeof value === 'number'
            ? value
            : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_WAIT_SECONDS) return null;
        return parsed;
    }

    app.get('/api/photo-widget/search', apiLimiter, authenticateToken, wrap(async (req, res) => {
        const userId = requireUserId(req);
        const rawQuery = req.query ? req.query.q : undefined;
        if (rawQuery !== undefined && rawQuery !== null && typeof rawQuery !== 'string') {
            fail('invalid_query', 400);
        }
        const query = typeof rawQuery === 'string' ? rawQuery : '';
        if (query.length > SEARCH_MAX_LENGTH) fail('invalid_query', 400);
        res.json({ success: true, users: await service.searchUsers(userId, query) });
    }));

    app.get('/api/photo-widget/state', apiLimiter, authenticateToken, wrap(async (req, res) => {
        const userId = requireUserId(req);
        res.json({ success: true, ...await service.getState(userId) });
    }));

    app.post('/api/photo-widget/bind/request', apiLimiter, authenticateToken, wrap(async (req, res) => {
        const userId = requireUserId(req);
        const targetId = parseInteger(req.body && req.body.userId, 1);
        if (targetId === null) fail('invalid_target', 400);
        res.json({ success: true, ...await service.requestBind(userId, targetId) });
    }));

    app.post('/api/photo-widget/bind/respond', apiLimiter, authenticateToken, wrap(async (req, res) => {
        const userId = requireUserId(req);
        const requesterId = parseInteger(req.body && req.body.userId, 1);
        if (requesterId === null) fail('invalid_target', 400);
        if (typeof (req.body && req.body.accept) !== 'boolean') fail('invalid_request', 400);
        res.json({ success: true, ...await service.respondBind(userId, requesterId, req.body.accept) });
    }));

    app.post('/api/photo-widget/unbind', apiLimiter, authenticateToken, wrap(async (req, res) => {
        const userId = requireUserId(req);
        await service.unbind(userId);
        res.json({ success: true });
    }));

    app.post('/api/photo-widget/nudge', apiLimiter, authenticateToken, wrap(async (req, res) => {
        const userId = requireUserId(req);
        res.json({ success: true, ...await service.nudge(userId) });
    }));

    app.post('/api/photo-widget/events', apiLimiter, authenticateToken, wrap(async (req, res) => {
        const userId = requireUserId(req);
        const after = parseInteger(req.body && req.body.after, 0);
        if (after === null) fail('invalid_after', 400);
        const waitSeconds = parseWaitSeconds(req.body && req.body.wait);
        if (waitSeconds === null) fail('invalid_wait', 400);
        const controller = new AbortController();
        const onClose = () => controller.abort();
        res.on('close', onClose);
        if (res.destroyed) controller.abort();
        try {
            const events = await service.waitForEvents({
                userId,
                after,
                waitMs: Math.round(waitSeconds * 1000),
                signal: controller.signal
            });
            if (res.writableEnded || res.destroyed) return;
            res.json({
                success: true,
                events,
                nextAfter: events.length > 0 ? events[events.length - 1].id : after
            });
        } finally {
            res.removeListener('close', onClose);
        }
    }));

    return Object.freeze({ ready, service, shutdown: () => service.shutdown() });
}

module.exports = { installPhotoWidgetRoutes };
