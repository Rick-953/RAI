'use strict';

// 照片小组件服务端回归：隔离 sqlite（临时文件）+ 隔离 express 实例。
// 覆盖搜索（前缀/邮箱/大小写/通配符/排除自己/最多 8 条/不回邮箱）、
// 绑定（申请/重复申请/同意/拒绝/互相申请自动同意/清除其他 pending）、
// nudge（3 秒合并、未绑定 409、事件隔离）、25 秒长轮询（1 秒内唤醒、超时、wait=0）、
// 越权（非收件人不能同意）、解绑后 409、输入校验与一对 active 的不变量。
// 运行：node scripts/photo-widget-regression.js
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const sqlite3 = require('sqlite3');
const { installPhotoWidgetRoutes } = require('../lib/photo-widget-routes');
const { MAX_WAIT_MS, NUDGE_COALESCE_MS } = require('../lib/photo-widget');

const TOKENS = {
    'token-alice': 1,
    'token-bob': 2,
    'token-carol': 3,
    'token-dave': 4,
    'token-erin': 5,
    'token-user00': 100,
    'token-user01': 101,
    'token-user02': 102
};
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function main() {
    const filename = path.join(os.tmpdir(), 'rai-photo-widget-test-' + crypto.randomUUID() + '.db');
    const db = new sqlite3.Database(filename);
    db.configure('busyTimeout', 5000);
    const run = (sql, params = []) => new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(error) { return error ? reject(error) : resolve(this); });
    });
    const get = (sql, params = []) => new Promise((resolve, reject) => {
        db.get(sql, params, (error, row) => (error ? reject(error) : resolve(row || null)));
    });
    const all = (sql, params = []) => new Promise((resolve, reject) => {
        db.all(sql, params, (error, rows) => (error ? reject(error) : resolve(rows || [])));
    });

    let server;
    let clock = Date.now();
    try {
        await run(`CREATE TABLE users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE NOT NULL,
            username TEXT,
            avatar_url TEXT
        )`);
        const seed = [
            [1, 'alice@test.invalid', 'alice', null],
            [2, 'bob@test.invalid', 'bob', '/avatars/bob.png'],
            [3, 'carol@test.invalid', 'carol', null],
            [4, 'dave@test.invalid', 'dave', null],
            [5, 'erin@test.invalid', 'erin', null]
        ];
        for (let index = 0; index < 10; index += 1) {
            seed.push([100 + index, `user${index}@test.invalid`, `user${String(index).padStart(2, '0')}`, null]);
        }
        for (const row of seed) {
            await run('INSERT INTO users (id, email, username, avatar_url) VALUES (?, ?, ?, ?)', row);
        }

        const app = express();
        app.use(express.json());
        const authenticateToken = (req, res, next) => {
            const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
            const userId = match ? TOKENS[match[1].trim()] : undefined;
            if (!userId) return res.status(401).json({ success: false, error: 'unauthorized' });
            req.user = { userId };
            return next();
        };
        const passThroughLimiter = (_req, _res, next) => next();
        // 注入可控时钟：只在测试里验证 3 秒合并窗口，正式安装使用 Date.now。
        installPhotoWidgetRoutes({
            app,
            authenticateToken,
            apiLimiter: passThroughLimiter,
            dbRunAsync: run,
            dbGetAsync: get,
            dbAllAsync: all,
            now: () => clock
        });
        server = await new Promise((resolve) => {
            const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
        });
        const baseUrl = 'http://127.0.0.1:' + server.address().port;

        function call(method, urlPath, { token, body } = {}) {
            return new Promise((resolve, reject) => {
                const payload = body === undefined ? null : JSON.stringify(body);
                const request = http.request(baseUrl + urlPath, {
                    method,
                    headers: {
                        ...(payload === null ? {} : {
                            'Content-Type': 'application/json',
                            'Content-Length': Buffer.byteLength(payload)
                        }),
                        ...(token ? { Authorization: 'Bearer ' + token } : {})
                    }
                }, (response) => {
                    let raw = '';
                    response.setEncoding('utf8');
                    response.on('data', (chunk) => { raw += chunk; });
                    response.on('end', () => {
                        let data = null;
                        try {
                            data = raw ? JSON.parse(raw) : null;
                        } catch (_error) {
                            data = raw;
                        }
                        resolve({ status: response.statusCode, headers: response.headers, data });
                    });
                });
                request.on('error', reject);
                request.end(payload === null ? undefined : payload);
            });
        }

        const search = (token, query) => call('GET', '/api/photo-widget/search?q=' + encodeURIComponent(query), { token });
        const stateOf = async (token) => (await call('GET', '/api/photo-widget/state', { token })).data;
        const eventsFor = (token, after, wait) => call('POST', '/api/photo-widget/events', { token, body: { after, wait } });
        const bindRequest = (token, userId) => call('POST', '/api/photo-widget/bind/request', { token, body: { userId } });
        const bindRespond = (token, userId, accept) => call('POST', '/api/photo-widget/bind/respond', { token, body: { userId, accept } });
        const nudge = (token) => call('POST', '/api/photo-widget/nudge', { token });
        const unbind = (token) => call('POST', '/api/photo-widget/unbind', { token });

        // ---------- 鉴权 ----------
        assert.equal((await call('GET', '/api/photo-widget/search?q=ali')).status, 401);
        assert.equal((await call('GET', '/api/photo-widget/state')).status, 401);
        assert.equal((await call('POST', '/api/photo-widget/nudge', { body: {} })).status, 401);

        // ---------- 搜索 ----------
        let response = await search('token-bob', '');
        assert.equal(response.status, 200);
        assert.deepEqual(response.data, { success: true, users: [] });
        assert.equal(response.headers['cache-control'], 'no-store');
        assert.deepEqual((await search('token-bob', '   ')).data.users, []);

        response = await search('token-bob', 'ali');
        assert.deepEqual(response.data.users, [{ id: 1, username: 'alice', avatarUrl: null }]);
        for (const user of response.data.users) {
            assert.deepEqual(Object.keys(user).sort(), ['avatarUrl', 'id', 'username']);
        }
        assert.deepEqual((await search('token-bob', 'ALI')).data.users.map((user) => user.id), [1], '用户名前缀不区分大小写');
        assert.deepEqual((await search('token-bob', 'alice@test.invalid')).data.users.map((user) => user.id), [1], '邮箱完全匹配');
        assert.deepEqual((await search('token-bob', 'alice@test')).data.users, [], '邮箱只做完全匹配');
        assert.deepEqual((await search('token-bob', '%')).data.users, [], 'LIKE 通配符必须转义');
        assert.deepEqual((await search('token-alice', 'alice')).data.users, [], '搜索排除自己');
        const limited = await search('token-bob', 'user');
        assert.equal(limited.data.users.length, 8, '最多返回 8 条');
        assert.ok(!JSON.stringify(limited.data).includes('@'), '搜索永不返回邮箱');
        assert.equal((await call('GET', '/api/photo-widget/search?q=' + 'a'.repeat(101), { token: 'token-bob' })).status, 400);
        assert.equal((await call('GET', '/api/photo-widget/search?q=a&q=b', { token: 'token-bob' })).status, 400, '重复 q 参数视为非法输入');

        // ---------- 初始状态 ----------
        let aliceState = await stateOf('token-alice');
        assert.deepEqual(aliceState.me, { id: 1, username: 'alice', avatarUrl: null });
        assert.equal(aliceState.partner, null);
        assert.deepEqual(aliceState.incoming, []);
        assert.deepEqual(aliceState.outgoing, []);
        assert.equal(aliceState.lastEventId, 0);

        // ---------- 发起绑定 ----------
        assert.equal((await bindRequest('token-alice', 1)).status, 400, '不能绑定自己');
        assert.equal((await bindRequest('token-alice', 0)).data.error, 'invalid_target');
        assert.equal((await bindRequest('token-alice', 'abc')).data.error, 'invalid_target');
        assert.equal((await bindRequest('token-alice', 2.5)).data.error, 'invalid_target');
        assert.equal((await bindRequest('token-alice', 9999)).data.error, 'user_not_found');
        response = await bindRequest('token-alice', 2);
        assert.deepEqual(response.data, { success: true, status: 'pending' });
        response = await bindRequest('token-alice', 2);
        assert.equal(response.status, 409);
        assert.equal(response.data.error, 'request_pending');

        aliceState = await stateOf('token-alice');
        assert.deepEqual(aliceState.outgoing, [{ id: 2, username: 'bob', avatarUrl: '/avatars/bob.png' }]);
        assert.deepEqual(aliceState.incoming, []);
        let bobState = await stateOf('token-bob');
        assert.deepEqual(bobState.incoming, [{ id: 1, username: 'alice', avatarUrl: null }]);
        assert.deepEqual(bobState.outgoing, []);
        assert.equal(bobState.lastEventId, 1, 'bind_request 事件写给收件人');

        // ---------- 收事件 + 同意绑定 ----------
        response = await eventsFor('token-bob', 0, 1);
        assert.equal(response.status, 200);
        assert.equal(response.data.events.length, 1);
        const bindRequestEvent = response.data.events[0];
        assert.equal(bindRequestEvent.type, 'bind_request');
        assert.deepEqual(bindRequestEvent.fromUser, { id: 1, username: 'alice', avatarUrl: null });
        assert.deepEqual(bindRequestEvent.payload, {});
        assert.equal(typeof bindRequestEvent.createdAt, 'number');
        assert.equal(response.data.nextAfter, bindRequestEvent.id);

        response = await bindRespond('token-carol', 1, true);
        assert.equal(response.status, 409, '非收件人不能替别人同意');
        assert.equal(response.data.error, 'not_requested');
        response = await bindRespond('token-alice', 2, true);
        assert.equal(response.status, 409, '发起人不能同意自己的申请');
        assert.equal(response.data.error, 'not_requested');

        response = await bindRespond('token-bob', 1, true);
        assert.deepEqual(response.data, { success: true, status: 'active', partner: { id: 1, username: 'alice', avatarUrl: null } });
        response = await eventsFor('token-alice', 0, 1);
        assert.equal(response.data.events.length, 1);
        assert.equal(response.data.events[0].type, 'bind_result');
        assert.deepEqual(response.data.events[0].payload, { accepted: true });
        assert.deepEqual(response.data.events[0].fromUser, { id: 2, username: 'bob', avatarUrl: '/avatars/bob.png' });
        aliceState = await stateOf('token-alice');
        bobState = await stateOf('token-bob');
        assert.deepEqual(aliceState.partner, { id: 2, username: 'bob', avatarUrl: '/avatars/bob.png' });
        assert.deepEqual(bobState.partner, { id: 1, username: 'alice', avatarUrl: null });
        assert.deepEqual(aliceState.outgoing, []);
        assert.deepEqual(bobState.incoming, []);

        // ---------- 长轮询：nudge 在 1 秒内唤醒 ----------
        bobState = await stateOf('token-bob');
        const pendingPoll = eventsFor('token-bob', bobState.lastEventId, 5);
        await sleep(150);
        const nudgeStartedAt = Date.now();
        response = await nudge('token-alice');
        const polled = await pendingPoll;
        const pollLatency = Date.now() - nudgeStartedAt;
        assert.deepEqual(response.data, { success: true, delivered: true, coalesced: false });
        assert.equal(polled.status, 200);
        assert.equal(polled.data.events.length, 1);
        assert.equal(polled.data.events[0].type, 'nudge');
        assert.deepEqual(polled.data.events[0].fromUser, { id: 1, username: 'alice', avatarUrl: null });
        assert.deepEqual(polled.data.events[0].payload, {});
        assert.ok(pollLatency < 1000, '长轮询应在 1 秒内被 nudge 唤醒，实际 ' + pollLatency + 'ms');
        assert.equal(polled.data.nextAfter, polled.data.events[0].id);
        const firstNudgeEventId = polled.data.events[0].id;

        // ---------- 3 秒内重复 nudge 合并 ----------
        response = await nudge('token-alice');
        assert.deepEqual(response.data, { success: true, delivered: true, coalesced: true });
        response = await eventsFor('token-bob', firstNudgeEventId, 0.2);
        assert.deepEqual(response.data.events, [], '合并的点击不写事件');
        assert.equal(response.data.nextAfter, firstNudgeEventId);
        clock += NUDGE_COALESCE_MS + 1;
        response = await nudge('token-alice');
        assert.deepEqual(response.data, { success: true, delivered: true, coalesced: false }, '超过 3 秒不再合并');
        response = await eventsFor('token-bob', firstNudgeEventId, 0.2);
        assert.equal(response.data.events.length, 1);
        assert.equal(response.data.events[0].type, 'nudge');
        assert.ok(response.data.events[0].id > firstNudgeEventId);
        // 连续跨过合并窗口的两次点击 → 两条事件按 id 升序补发。
        clock += NUDGE_COALESCE_MS + 1;
        await nudge('token-alice');
        clock += NUDGE_COALESCE_MS + 1;
        await nudge('token-alice');
        response = await eventsFor('token-bob', firstNudgeEventId, 1);
        assert.equal(response.data.events.length, 3);
        const batchIds = response.data.events.map((event) => event.id);
        assert.deepEqual(batchIds, [...batchIds].sort((left, right) => left - right), '事件按 id 升序返回');
        assert.equal(response.data.nextAfter, batchIds[batchIds.length - 1]);

        // 客户端中途断开长轮询：服务端清理等待者，后续请求不受影响。
        await new Promise((resolve) => {
            const aborted = http.request(baseUrl + '/api/photo-widget/events', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': 2 }
            }, () => resolve());
            aborted.on('error', () => resolve());
            aborted.write('{}');
            aborted.end();
            setTimeout(() => {
                aborted.destroy();
                setTimeout(resolve, 100);
            }, 100);
        });
        assert.equal((await stateOf('token-bob')).partner.id, 1, '长轮询断开后接口仍正常');

        // ---------- 解绑 ----------
        const aliceLastBeforeUnbind = (await stateOf('token-alice')).lastEventId;
        response = await unbind('token-bob');
        assert.deepEqual(response.data, { success: true });
        response = await eventsFor('token-alice', aliceLastBeforeUnbind, 0.2);
        assert.equal(response.data.events.length, 1);
        assert.equal(response.data.events[0].type, 'unbind');
        assert.deepEqual(response.data.events[0].fromUser, { id: 2, username: 'bob', avatarUrl: '/avatars/bob.png' });
        assert.equal((await stateOf('token-alice')).partner, null);
        assert.equal((await stateOf('token-bob')).partner, null);
        response = await nudge('token-alice');
        assert.equal(response.status, 409, '解绑后 nudge 必须 409');
        assert.equal(response.data.error, 'not_bound');
        response = await nudge('token-bob');
        assert.equal(response.status, 409);
        response = await unbind('token-alice');
        assert.equal(response.status, 409);
        assert.equal(response.data.error, 'not_bound');

        // ---------- 互相申请 → 自动同意 ----------
        response = await bindRequest('token-alice', 3);
        assert.deepEqual(response.data, { success: true, status: 'pending' });
        const aliceLastBeforeAutoAccept = (await stateOf('token-alice')).lastEventId;
        response = await bindRequest('token-carol', 1);
        assert.deepEqual(response.data, { success: true, status: 'active', partner: { id: 1, username: 'alice', avatarUrl: null } });
        response = await eventsFor('token-alice', aliceLastBeforeAutoAccept, 0.2);
        assert.equal(response.data.events.length, 1);
        assert.equal(response.data.events[0].type, 'bind_result');
        assert.deepEqual(response.data.events[0].payload, { accepted: true });
        assert.deepEqual(response.data.events[0].fromUser, { id: 3, username: 'carol', avatarUrl: null });
        aliceState = await stateOf('token-alice');
        assert.deepEqual(aliceState.partner, { id: 3, username: 'carol', avatarUrl: null });
        assert.deepEqual(aliceState.outgoing, []);
        assert.deepEqual((await stateOf('token-carol')).incoming, []);

        // ---------- 同意时清掉双方其他 pending ----------
        assert.deepEqual((await bindRequest('token-bob', 5)).data, { success: true, status: 'pending' });
        assert.deepEqual((await bindRequest('token-dave', 5)).data, { success: true, status: 'pending' });
        response = await bindRespond('token-erin', 2, true);
        assert.deepEqual(response.data, { success: true, status: 'active', partner: { id: 2, username: 'bob', avatarUrl: '/avatars/bob.png' } });
        assert.deepEqual((await stateOf('token-dave')).outgoing, [], '同意后清掉涉及双方的其他 pending');
        assert.deepEqual((await stateOf('token-erin')).incoming, []);
        assert.deepEqual((await stateOf('token-bob')).partner, { id: 5, username: 'erin', avatarUrl: null });

        // ---------- 拒绝 ----------
        assert.deepEqual((await bindRequest('token-dave', 100)).data, { success: true, status: 'pending' });
        const daveLastBeforeReject = (await stateOf('token-dave')).lastEventId;
        response = await bindRespond('token-user00', 4, false);
        assert.deepEqual(response.data, { success: true, status: 'rejected' });
        response = await eventsFor('token-dave', daveLastBeforeReject, 0.2);
        assert.equal(response.data.events.length, 1);
        assert.equal(response.data.events[0].type, 'bind_result');
        assert.deepEqual(response.data.events[0].payload, { accepted: false });
        assert.deepEqual((await stateOf('token-dave')).outgoing, []);
        response = await bindRespond('token-user00', 4, false);
        assert.equal(response.status, 409);
        assert.equal(response.data.error, 'not_requested');

        // ---------- 一对 active 不变量 ----------
        assert.equal((await get('SELECT COUNT(*) AS count FROM photo_widget_pairs WHERE user_low >= user_high')).count, 0, '始终 low < high');
        assert.equal((await all('SELECT user_low, user_high FROM photo_widget_pairs GROUP BY user_low, user_high HAVING COUNT(*) > 1')).length, 0);
        for (const userId of [1, 2, 3, 4, 5]) {
            const activeRows = await get("SELECT COUNT(*) AS count FROM photo_widget_pairs WHERE status = 'active' AND (user_low = ? OR user_high = ?)", [userId, userId]);
            assert.ok(activeRows.count <= 1, '每个用户最多一个 active 绑定');
        }
        assert.equal((await get("SELECT COUNT(*) AS count FROM photo_widget_pairs WHERE status = 'active'")).count, 2);
        assert.equal((await bindRequest('token-dave', 1)).data.error, 'already_bound', '对方已绑定时拒绝申请');
        assert.equal((await bindRequest('token-alice', 3)).data.error, 'already_bound', '自己已绑定时拒绝申请');

        // ---------- 用户间事件隔离 ----------
        assert.ok((await get('SELECT COUNT(*) AS count FROM photo_widget_events')).count > 0);
        response = await eventsFor('token-user01', 0, 0.2);
        assert.deepEqual(response.data.events, [], '事件只按收件人返回');
        assert.equal(response.data.nextAfter, 0);

        // ---------- wait=0 / 超时 / 校验 ----------
        const immediateStartedAt = Date.now();
        response = await eventsFor('token-user01', 0, 0);
        assert.deepEqual(response.data.events, []);
        assert.ok(Date.now() - immediateStartedAt < 500, 'wait=0 立即返回');

        const timeoutStartedAt = Date.now();
        response = await eventsFor('token-user02', 0, 0.2);
        const timeoutElapsed = Date.now() - timeoutStartedAt;
        assert.deepEqual(response.data.events, []);
        assert.equal(response.data.nextAfter, 0);
        assert.ok(timeoutElapsed >= 150 && timeoutElapsed < 1500, '没有事件时挂起到 wait 后返回空，实际 ' + timeoutElapsed + 'ms');
        assert.ok(MAX_WAIT_MS === 25000);

        const invalid = await Promise.all([
            eventsFor('token-alice', -1, 0),
            eventsFor('token-alice', 1.5, 0),
            eventsFor('token-alice', 'x', 0),
            eventsFor('token-alice', 0, 25.5),
            eventsFor('token-alice', 0, -1),
            eventsFor('token-alice', 0, 'x'),
            bindRespond('token-alice', 1, 'yes'),
            call('POST', '/api/photo-widget/bind/request', { token: 'token-alice', body: {} })
        ]);
        assert.deepEqual(invalid.map((item) => item.status), [400, 400, 400, 400, 400, 400, 400, 400]);
        assert.deepEqual(invalid.map((item) => item.data.error),
            ['invalid_after', 'invalid_after', 'invalid_after', 'invalid_wait', 'invalid_wait', 'invalid_wait', 'invalid_request', 'invalid_target']);

        // ---------- 7 天事件保留 ----------
        await run("INSERT INTO photo_widget_events (user_id, type, from_user_id, payload, created_at) VALUES (101, 'nudge', 1, '{}', ?)",
            [clock - 8 * 24 * 60 * 60 * 1000]);
        await bindRequest('token-dave', 101);
        assert.equal((await get('SELECT COUNT(*) AS count FROM photo_widget_events WHERE user_id = 101 AND created_at < ?',
            [clock - 7 * 24 * 60 * 60 * 1000])).count, 0, '插入新事件时顺手清掉 7 天前的行');

        console.log('photo-widget regression PASS: auth, search (prefix/case/email-exact/wildcard/self/limit/no-email), state, bind request/duplicate/respond/auto-accept/reject/clear-other-pending, one-active invariant, unbind, nudge (1s long-poll wake, 3s coalesce, not_bound 409), per-user event isolation, long-poll timeout/wait=0, input validation, 7-day retention');
    } finally {
        if (server) {
            await new Promise((resolve) => {
                server.close(resolve);
                if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
            });
        }
        await new Promise((resolve) => db.close(() => resolve()));
        try {
            fs.unlinkSync(filename);
        } catch (_error) {
            // 临时文件可能已被清理，忽略。
        }
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
