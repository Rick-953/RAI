'use strict';

const { createDecisionWorkbenchService } = require('./decision-workbench');

function installDecisionWorkbenchRoutes({
    app,
    authenticateToken,
    apiLimiter,
    dbRunAsync,
    dbGetAsync,
    dbAllAsync
} = {}) {
    for (const method of ['use', 'get', 'post', 'delete']) {
        if (!app || typeof app[method] !== 'function') throw new TypeError('an express app is required');
    }
    for (const [name, value] of Object.entries({ authenticateToken, apiLimiter })) {
        if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
    }
    const service = createDecisionWorkbenchService({ dbRunAsync, dbGetAsync, dbAllAsync });
    const ready = service.migrate();
    ready.catch(() => undefined); // Requests await the same migration and report failure.
    const basePath = '/api/sessions/:id/decision-pins';

    const fail = (code, statusCode) => {
        throw Object.assign(new Error(code), { code, statusCode });
    };

    function setPrivateHeaders(res) {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Referrer-Policy', 'no-referrer');
    }

    // The shared auth/limiter can reject before our handler; keep the API error shape.
    app.use(basePath, (_req, res, next) => {
        setPrivateHeaders(res);
        const json = res.json;
        res.json = function sendJson(body) {
            if (res.statusCode >= 400 && body && typeof body === 'object') {
                const code = body.code || ({
                    401: 'unauthorized', 403: 'forbidden', 429: 'rate_limited'
                })[res.statusCode] || 'request_failed';
                body = { ...body, code, error: body.error || code };
            }
            return json.call(this, body);
        };
        next();
    });

    function sendError(res, error) {
        if (res.headersSent) return;
        setPrivateHeaders(res);
        const requestedStatus = error.statusCode || error.status;
        const status = Number.isInteger(requestedStatus) && requestedStatus >= 400 && requestedStatus < 600
            ? requestedStatus : 500;
        const code = status >= 500 ? 'internal_error'
            : error.type === 'entity.parse.failed' ? 'invalid_json'
            : error.type === 'entity.too.large' ? 'request_too_large'
            : error.code || 'request_failed';
        if (status >= 500) console.error(' decision-workbench route failed:', code);
        res.status(status).json({ code, error: code });
    }

    const wrap = (handler) => async (req, res) => {
        try {
            await ready;
            const userId = req.user && req.user.userId;
            if (!Number.isSafeInteger(userId) || userId <= 0) fail('unauthorized', 401);
            const sessionId = req.params.id;
            if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 180
                || /[\u0000-\u001f\u007f]/.test(sessionId)) fail('invalid_session_id', 400);
            await handler(req, res, userId, sessionId);
        } catch (error) {
            sendError(res, error);
        }
    };

    app.get(basePath, apiLimiter, authenticateToken, wrap(async (_req, res, userId, sessionId) => {
        res.json({ pins: await service.listPins(userId, sessionId) });
    }));

    app.post(basePath, apiLimiter, authenticateToken, wrap(async (req, res, userId, sessionId) => {
        const body = req.body;
        if (!body || typeof body !== 'object' || Array.isArray(body)) fail('invalid_request', 400);
        if (!Number.isSafeInteger(body.source_message_id) || body.source_message_id <= 0) {
            fail('invalid_source_message_id', 400);
        }
        const result = await service.createPin(userId, sessionId, body.source_message_id);
        res.status(result.created ? 201 : 200).json(result);
    }));

    app.delete(basePath + '/:pinId', apiLimiter, authenticateToken, wrap(async (req, res, userId, sessionId) => {
        const pinId = Number(req.params.pinId);
        if (!/^[1-9]\d{0,15}$/.test(req.params.pinId) || !Number.isSafeInteger(pinId)) {
            fail('invalid_pin_id', 400);
        }
        await service.deletePin(userId, sessionId, pinId);
        res.json({ success: true });
    }));

    // JSON parsing runs in the host before these routes.
    app.use(basePath, (error, _req, res, next) => {
        if (res.headersSent) return next(error);
        sendError(res, error);
    });

    return Object.freeze({ ready, service });
}

module.exports = { installDecisionWorkbenchRoutes };
