"use strict";

// The public picker, administrator routes and account-wide allowance share one policy.
const CHAT_MODEL_CATALOG = Object.freeze([
    { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', group: '全部模型' },
    { id: 'gpt-6.1-sol', name: 'GPT 6.1 Sol', group: '全部模型' },
    { id: 'gpt-6-luna', name: 'GPT 6 Luna', group: '全部模型' },
    { id: 'gpt-6-astra', name: 'GPT 6 Astra', group: '全部模型' }
].map(model => Object.freeze({ ...model, vision: true, contextWindow: 256000, thinkingProfiles: Object.freeze(['low', 'medium', 'high', 'max']) })));
const CHAT_MODEL_IDS = Object.freeze(CHAT_MODEL_CATALOG.map(model => model.id));
const CHAT_MODEL_LIMITS = Object.freeze({
    free: Object.freeze({ 'gpt-6-astra': 3, 'gpt-6.1-sol': 50, 'gpt-6-luna': 100 }),
    pro: Object.freeze({ 'gpt-6-astra': 50, 'gpt-6.1-sol': 100, 'gpt-6-luna': 200 }),
    max: Object.freeze({ 'gpt-6-astra': 80, 'gpt-6.1-sol': 200, 'gpt-6-luna': 500 })
});
const CHAT_MODEL_WINDOW_MS = 24 * 60 * 60 * 1000;
const RESERVATION_LEASE_MS = 15 * 60 * 1000;
function activeTier(user, now) {
    const tier = String(user?.membership || 'free').toLowerCase();
    const expires = Date.parse(user?.membership_end || '');
    return ['pro', 'max'].includes(tier) && Number.isFinite(expires) && expires > now ? tier : 'free';
}
function createChatModelQuotaService({ withTransaction, now = Date.now }) {
    async function schema(tx) {
        await tx.run(`CREATE TABLE IF NOT EXISTS chat_model_turns (
            user_id INTEGER NOT NULL, request_id TEXT NOT NULL, model_id TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('reserved','completed','released')),
            completed_at INTEGER, lease_until INTEGER NOT NULL,
            PRIMARY KEY(user_id, request_id, model_id),
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE)`);
        await tx.run('CREATE INDEX IF NOT EXISTS idx_chat_model_turns_window ON chat_model_turns(user_id, model_id, status, completed_at)');
    }
    async function reserve(userId, requestId, modelId) {
        if (!Object.hasOwn(CHAT_MODEL_LIMITS.free, modelId)) return null;
        return withTransaction(async tx => {
            await schema(tx);
            const time = now();
            await tx.run("UPDATE chat_model_turns SET status = 'released' WHERE status = 'reserved' AND lease_until <= ?", [time]);
            const existing = await tx.get('SELECT status FROM chat_model_turns WHERE user_id = ? AND request_id = ? AND model_id = ?', [userId, requestId, modelId]);
            if (existing && existing.status !== 'released') return { allowed: true, idempotent: true };
            const user = await tx.get('SELECT membership, membership_end FROM users WHERE id = ?', [userId]);
            if (!user) throw new Error('chat_quota_user_missing');
            const tier = activeTier(user, time);
            const limit = CHAT_MODEL_LIMITS[tier][modelId];
            const row = await tx.get(`SELECT COUNT(*) AS count,
                MIN(CASE WHEN status = 'completed' THEN completed_at + ? ELSE lease_until END) AS reset_at
                FROM chat_model_turns WHERE user_id = ? AND model_id = ?
                AND ((status = 'completed' AND completed_at > ?) OR (status = 'reserved' AND lease_until > ?))`,
                [CHAT_MODEL_WINDOW_MS, userId, modelId, time - CHAT_MODEL_WINDOW_MS, time]);
            if (Number(row.count) >= limit) {
                const error = new Error(`${modelId} 在滚动 24 小时内的 ${limit} 次对话额度已用完，请等待额度恢复。`);
                error.code = 'model_chat_quota_exceeded';
                error.status = 429;
                error.quota = { model: modelId, tier, limit, used: Number(row.count), resetAt: new Date(Number(row.reset_at)).toISOString(), windowHours: 24 };
                throw error;
            }
            await tx.run(`INSERT INTO chat_model_turns(user_id, request_id, model_id, status, completed_at, lease_until)
                VALUES (?, ?, ?, 'reserved', NULL, ?) ON CONFLICT(user_id, request_id, model_id)
                DO UPDATE SET status = 'reserved', completed_at = NULL, lease_until = excluded.lease_until`,
                [userId, requestId, modelId, time + RESERVATION_LEASE_MS]);
            return { allowed: true, model: modelId, tier, limit, remaining: limit - Number(row.count) - 1 };
        });
    }
    async function settle(userId, requestId, completedModels = []) {
        return withTransaction(async tx => {
            await schema(tx);
            const time = now();
            // Completion is idempotent; retries/tools within a turn share the request ID.
            for (const modelId of new Set(completedModels)) {
                await tx.run("UPDATE chat_model_turns SET status = 'completed', completed_at = ? WHERE user_id = ? AND request_id = ? AND model_id = ? AND status = 'reserved'",
                    [time, userId, requestId, modelId]);
            }
            await tx.run("UPDATE chat_model_turns SET status = 'released' WHERE user_id = ? AND request_id = ? AND status = 'reserved'", [userId, requestId]);
        });
    }
    async function renew(userId, requestId) {
        return withTransaction(async tx => {
            await schema(tx);
            await tx.run("UPDATE chat_model_turns SET lease_until = ? WHERE user_id = ? AND request_id = ? AND status = 'reserved'", [now() + RESERVATION_LEASE_MS, userId, requestId]);
        });
    }
    return { reserve, settle, renew };
}
module.exports = { CHAT_MODEL_CATALOG, CHAT_MODEL_IDS, CHAT_MODEL_LIMITS, CHAT_MODEL_WINDOW_MS, activeTier, createChatModelQuotaService };
