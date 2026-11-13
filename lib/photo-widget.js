'use strict';

// 照片桌面小组件的数据层：一对一绑定关系、事件队列、进程内长轮询等待者。
// 只存“谁和谁绑定 / 谁点了谁”，照片始终留在客户端本机。
// 单实例假设：等待者放在进程内存里，重启即丢，客户端靠 nextAfter 补发。
// ponytail: 真要水平扩容时把 waiters 换 Redis pub/sub；现在单进程足够。

const EVENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const NUDGE_COALESCE_MS = 3000;
const MAX_WAIT_MS = 25 * 1000;
const MAX_EVENTS_PER_POLL = 100;
const EVENT_TYPES = new Set(['nudge', 'bind_request', 'bind_result', 'unbind']);

function fail(code, statusCode) {
    throw Object.assign(new Error(code), { code, statusCode });
}

function isConstraintError(error) {
    return String((error && error.code) || '').startsWith('SQLITE_CONSTRAINT');
}

function toPublicUser(row) {
    return {
        id: Number(row.id),
        username: row.username === null || row.username === undefined ? null : String(row.username),
        avatarUrl: row.avatar_url === null || row.avatar_url === undefined ? null : String(row.avatar_url)
    };
}

function pairBounds(userA, userB) {
    return userA < userB ? [userA, userB] : [userB, userA];
}

function otherUserId(pair, userId) {
    return Number(pair.user_low) === Number(userId) ? Number(pair.user_high) : Number(pair.user_low);
}

function parsePayload(raw) {
    try {
        const parsed = JSON.parse(String(raw === null || raw === undefined ? '{}' : raw));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_error) {
        return {};
    }
}

function escapeLike(value) {
    return value.replace(/[\\%_]/g, (character) => '\\' + character);
}

const SCHEMA_STATEMENTS = [
    `CREATE TABLE IF NOT EXISTS photo_widget_pairs (
        id INTEGER PRIMARY KEY,
        user_low INTEGER NOT NULL,
        user_high INTEGER NOT NULL,
        status TEXT NOT NULL,
        requested_by INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(user_low, user_high)
    )`,
    // 每个用户同时只允许一个 active 绑定，用两条 SQLite 部分唯一索引兜底并发。
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_photo_widget_pairs_active_low
        ON photo_widget_pairs(user_low) WHERE status = 'active'`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_photo_widget_pairs_active_high
        ON photo_widget_pairs(user_high) WHERE status = 'active'`,
    `CREATE TABLE IF NOT EXISTS photo_widget_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        from_user_id INTEGER,
        payload TEXT,
        created_at INTEGER NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_photo_widget_events_user ON photo_widget_events(user_id, id)'
];

function createPhotoWidgetService({ dbRunAsync, dbGetAsync, dbAllAsync, now = () => Date.now() } = {}) {
    for (const [name, value] of Object.entries({ dbRunAsync, dbGetAsync, dbAllAsync })) {
        if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
    }
    if (typeof now !== 'function') throw new TypeError('now must be a function');

    const waiters = new Map(); // userId -> Set<waiter>
    const lastNudgeByUser = new Map(); // userId -> { pairId, at }

    async function migrate() {
        for (const statement of SCHEMA_STATEMENTS) await dbRunAsync(statement);
        return true;
    }

    function eventFromRow(row) {
        return {
            id: Number(row.id),
            type: String(row.type),
            fromUser: {
                id: row.from_user_id === null || row.from_user_id === undefined ? null : Number(row.from_user_id),
                username: row.from_username === null || row.from_username === undefined ? null : String(row.from_username),
                avatarUrl: row.from_avatar === null || row.from_avatar === undefined ? null : String(row.from_avatar)
            },
            payload: parsePayload(row.payload),
            createdAt: Number(row.created_at)
        };
    }

    async function listEvents(userId, after) {
        const rows = await dbAllAsync(
            `SELECT e.id, e.type, e.from_user_id, e.payload, e.created_at,
                    u.username AS from_username, u.avatar_url AS from_avatar
             FROM photo_widget_events e
             LEFT JOIN users u ON u.id = e.from_user_id
             WHERE e.user_id = ? AND e.id > ?
             ORDER BY e.id ASC LIMIT ?`,
            [userId, after, MAX_EVENTS_PER_POLL]
        );
        return rows.map(eventFromRow);
    }

    function wakeWaiters(userId, eventId) {
        const pending = waiters.get(userId);
        if (!pending) return;
        for (const waiter of Array.from(pending)) {
            if (eventId <= waiter.after) continue;
            waiter.settle();
        }
    }

    async function pushEvent(userId, type, fromUserId, payload = {}) {
        if (!EVENT_TYPES.has(type)) throw new TypeError(`unknown photo widget event type: ${type}`);
        const createdAt = Number(now());
        // 7 天前的行在每次插入时顺手清掉，表不会无限增长。
        await dbRunAsync('DELETE FROM photo_widget_events WHERE created_at < ?', [createdAt - EVENT_TTL_MS]);
        const result = await dbRunAsync(
            `INSERT INTO photo_widget_events (user_id, type, from_user_id, payload, created_at)
             VALUES (?, ?, ?, ?, ?)`,
            [userId, type, fromUserId, JSON.stringify(payload || {}), createdAt]
        );
        const eventId = Number(result.lastID);
        wakeWaiters(userId, eventId);
        return eventId;
    }

    function waitForEvents({ userId, after, waitMs = MAX_WAIT_MS, signal } = {}) {
        const timeoutMs = Math.max(0, Math.min(MAX_WAIT_MS, Number(waitMs) || 0));
        return new Promise((resolve, reject) => {
            let settled = false;
            let timer = null;
            const waiter = { after, settle: () => settle() };

            const cleanup = () => {
                if (timer) {
                    clearTimeout(timer);
                    timer = null;
                }
                if (signal) signal.removeEventListener('abort', onAbort);
                const pending = waiters.get(userId);
                if (pending) {
                    pending.delete(waiter);
                    if (pending.size === 0) waiters.delete(userId);
                }
            };
            const settle = (immediate) => {
                if (settled) return;
                settled = true;
                cleanup();
                if (immediate !== undefined) {
                    resolve(immediate);
                    return;
                }
                listEvents(userId, after).then(resolve, reject);
            };
            const onAbort = () => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve([]);
            };

            const pending = waiters.get(userId) || new Set();
            waiters.set(userId, pending);
            pending.add(waiter);
            if (timeoutMs > 0) timer = setTimeout(() => settle(), timeoutMs);
            if (signal) {
                if (signal.aborted) {
                    onAbort();
                    return;
                }
                signal.addEventListener('abort', onAbort, { once: true });
            }
            // 先登记等待者再查一次：关闭“查库为空之后、登记之前恰好插入事件”的竞态窗口。
            listEvents(userId, after).then((events) => {
                if (settled) return;
                if (events.length > 0) return settle(events);
                if (timeoutMs === 0) settle([]);
                return undefined;
            }, (error) => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(error);
            });
        });
    }

    async function searchUsers(userId, query) {
        const trimmed = String(query === null || query === undefined ? '' : query).trim();
        if (!trimmed) return [];
        if (trimmed.length > 100) fail('invalid_query', 400);
        const prefix = escapeLike(trimmed) + '%';
        const rows = await dbAllAsync(
            `SELECT id, username, avatar_url FROM users
             WHERE id <> ?
               AND (username LIKE ? ESCAPE '\\' OR LOWER(email) = LOWER(?))
             ORDER BY username COLLATE NOCASE ASC, id ASC
             LIMIT 8`,
            [userId, prefix, trimmed]
        );
        return rows.map(toPublicUser);
    }

    async function getState(userId) {
        const me = await dbGetAsync('SELECT id, username, avatar_url FROM users WHERE id = ?', [userId]);
        if (!me) fail('user_not_found', 404);
        const activePair = await findActivePair(userId);
        let partner = null;
        if (activePair) {
            const partnerRow = await dbGetAsync(
                'SELECT id, username, avatar_url FROM users WHERE id = ?',
                [otherUserId(activePair, userId)]
            );
            if (partnerRow) partner = toPublicUser(partnerRow);
        }
        const pendingRows = await dbAllAsync(
            `SELECT p.requested_by, u.id AS id, u.username, u.avatar_url
             FROM photo_widget_pairs p
             JOIN users u ON u.id = CASE WHEN p.user_low = ? THEN p.user_high ELSE p.user_low END
             WHERE p.status = 'pending' AND (p.user_low = ? OR p.user_high = ?)
             ORDER BY p.created_at DESC`,
            [userId, userId, userId]
        );
        const incoming = [];
        const outgoing = [];
        for (const row of pendingRows) {
            if (Number(row.requested_by) === Number(userId)) outgoing.push(toPublicUser(row));
            else incoming.push(toPublicUser(row));
        }
        const lastRow = await dbGetAsync(
            'SELECT COALESCE(MAX(id), 0) AS last_event_id FROM photo_widget_events WHERE user_id = ?',
            [userId]
        );
        return {
            me: toPublicUser(me),
            partner,
            incoming,
            outgoing,
            lastEventId: Number((lastRow && lastRow.last_event_id) || 0)
        };
    }

    async function findActivePair(userId) {
        return dbGetAsync(
            `SELECT id, user_low, user_high, requested_by FROM photo_widget_pairs
             WHERE status = 'active' AND (user_low = ? OR user_high = ?) LIMIT 1`,
            [userId, userId]
        );
    }

    async function clearOtherPending(pairId, userA, userB) {
        await dbRunAsync(
            `DELETE FROM photo_widget_pairs
             WHERE id <> ? AND status = 'pending'
               AND (user_low IN (?, ?) OR user_high IN (?, ?))`,
            [pairId, userA, userB, userA, userB]
        );
    }

    async function activatePair(pairId, userA, userB) {
        let result;
        try {
            result = await dbRunAsync(
                "UPDATE photo_widget_pairs SET status = 'active', updated_at = ? WHERE id = ? AND status = 'pending'",
                [Number(now()), pairId]
            );
        } catch (error) {
            if (isConstraintError(error)) fail('already_bound', 409);
            throw error;
        }
        if (Number(result.changes) !== 1) fail('not_requested', 409);
        await clearOtherPending(pairId, userA, userB);
    }

    async function requestBind(userId, targetId) {
        if (!Number.isSafeInteger(targetId) || targetId <= 0 || targetId === Number(userId)) {
            fail('invalid_target', 400);
        }
        const targetRow = await dbGetAsync('SELECT id, username, avatar_url FROM users WHERE id = ?', [targetId]);
        if (!targetRow) fail('user_not_found', 404);
        if (await findActivePair(userId)) fail('already_bound', 409);
        if (await findActivePair(targetId)) fail('already_bound', 409);
        const target = toPublicUser(targetRow);
        const [userLow, userHigh] = pairBounds(Number(userId), targetId);
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const existing = await dbGetAsync(
                'SELECT id, status, requested_by FROM photo_widget_pairs WHERE user_low = ? AND user_high = ?',
                [userLow, userHigh]
            );
            if (existing) {
                if (existing.status === 'active') fail('already_bound', 409);
                if (Number(existing.requested_by) === Number(userId)) fail('request_pending', 409);
                // 对方正好也在申请我 → 直接同意。
                await activatePair(existing.id, userId, targetId);
                await pushEvent(targetId, 'bind_result', userId, { accepted: true });
                return { status: 'active', partner: target };
            }
            try {
                const createdAt = Number(now());
                await dbRunAsync(
                    `INSERT INTO photo_widget_pairs (user_low, user_high, status, requested_by, created_at, updated_at)
                     VALUES (?, ?, 'pending', ?, ?, ?)`,
                    [userLow, userHigh, userId, createdAt, createdAt]
                );
            } catch (error) {
                // 并发插入撞 UNIQUE(user_low, user_high)：重读一行再按既有状态处理。
                if (isConstraintError(error)) continue;
                throw error;
            }
            await pushEvent(targetId, 'bind_request', userId, {});
            return { status: 'pending' };
        }
        fail('request_pending', 409);
    }

    async function respondBind(userId, requesterId, accept) {
        if (!Number.isSafeInteger(requesterId) || requesterId <= 0 || requesterId === Number(userId)) {
            fail('invalid_target', 400);
        }
        const [userLow, userHigh] = pairBounds(Number(userId), requesterId);
        const pair = await dbGetAsync(
            `SELECT id FROM photo_widget_pairs
             WHERE user_low = ? AND user_high = ? AND status = 'pending' AND requested_by = ?`,
            [userLow, userHigh, requesterId]
        );
        if (!pair) fail('not_requested', 409);
        const requesterRow = await dbGetAsync('SELECT id, username, avatar_url FROM users WHERE id = ?', [requesterId]);
        if (!requesterRow) fail('not_requested', 409);
        const requester = toPublicUser(requesterRow);
        if (accept !== true) {
            const removed = await dbRunAsync("DELETE FROM photo_widget_pairs WHERE id = ? AND status = 'pending'", [pair.id]);
            if (Number(removed.changes) !== 1) fail('not_requested', 409);
            await pushEvent(requesterId, 'bind_result', userId, { accepted: false });
            return { status: 'rejected' };
        }
        if (await findActivePair(userId)) fail('already_bound', 409);
        if (await findActivePair(requesterId)) fail('already_bound', 409);
        await activatePair(pair.id, userId, requesterId);
        await pushEvent(requesterId, 'bind_result', userId, { accepted: true });
        return { status: 'active', partner: requester };
    }

    async function unbind(userId) {
        const pair = await findActivePair(userId);
        if (!pair) fail('not_bound', 409);
        const partnerId = otherUserId(pair, userId);
        const removed = await dbRunAsync("DELETE FROM photo_widget_pairs WHERE id = ? AND status = 'active'", [pair.id]);
        if (Number(removed.changes) !== 1) fail('not_bound', 409);
        lastNudgeByUser.delete(Number(userId));
        lastNudgeByUser.delete(partnerId);
        await pushEvent(partnerId, 'unbind', userId, {});
        return { partnerId };
    }

    async function nudge(userId) {
        const pair = await findActivePair(userId);
        if (!pair) fail('not_bound', 409);
        const partnerId = otherUserId(pair, userId);
        const at = Number(now());
        const last = lastNudgeByUser.get(Number(userId));
        // 同一个用户对同一段绑定 3 秒内重复点击只写一条事件（防连点刷屏）。
        if (last && last.pairId === Number(pair.id) && at - last.at < NUDGE_COALESCE_MS) {
            return { delivered: true, coalesced: true };
        }
        lastNudgeByUser.set(Number(userId), { pairId: Number(pair.id), at });
        await pushEvent(partnerId, 'nudge', userId, {});
        return { delivered: true, coalesced: false };
    }

    function shutdown() {
        for (const pending of Array.from(waiters.values())) {
            for (const waiter of Array.from(pending)) waiter.settle([]);
        }
    }

    return Object.freeze({
        activatePair,
        clearOtherPending,
        getState,
        listEvents,
        migrate,
        nudge,
        pushEvent,
        requestBind,
        respondBind,
        searchUsers,
        shutdown,
        unbind,
        waitForEvents
    });
}

module.exports = { createPhotoWidgetService, EVENT_TTL_MS, MAX_WAIT_MS, NUDGE_COALESCE_MS };
