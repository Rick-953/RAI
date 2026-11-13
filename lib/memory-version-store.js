'use strict';

const MAX_MEMORY_BATCH_SIZE = 500;
const VERSION_SCHEMA = `CREATE TABLE IF NOT EXISTS user_memory_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    operation TEXT NOT NULL,
    memories_json TEXT NOT NULL,
    memory_count INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`;

// A separate connection owns each transaction. Other requests on the server's shared
// connection cannot accidentally join a memory edit or its backup transaction.
function createMemoryVersionStore({ openDatabase, buildMemoryKey }) {
    const run = (db, sql, params = []) => new Promise((resolve, reject) => {
        db.run(sql, params, function (error) {
            if (error) reject(error); else resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
    const all = (db, sql, params = []) => new Promise((resolve, reject) => {
        db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows));
    });
    const close = db => new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
    const userIdValue = value => {
        if (!Number.isSafeInteger(Number(value)) || Number(value) <= 0) throw new Error('memory_user_missing');
        return Number(value);
    };
    function batchSize(items) {
        if (!Array.isArray(items) || items.length < 1 || items.length > MAX_MEMORY_BATCH_SIZE) throw new Error('memory_batch_size');
    }
    async function connect() {
        const db = await openDatabase();
        try {
            await run(db, 'PRAGMA busy_timeout = 15000');
            await run(db, 'PRAGMA foreign_keys = ON');
            await run(db, VERSION_SCHEMA);
            return db;
        } catch (error) { await close(db); throw error; }
    }
    async function edit(userId, operation, apply) {
        const id = userIdValue(userId);
        const db = await connect();
        let active = false;
        try {
            await run(db, 'BEGIN IMMEDIATE');
            active = true;
            const before = await all(db, 'SELECT * FROM user_memories WHERE user_id = ? AND deleted_at IS NULL ORDER BY id', [id]);
            const version = await run(db, `INSERT INTO user_memory_versions (user_id, operation, memories_json, memory_count)
                VALUES (?, ?, ?, ?)`, [id, operation, JSON.stringify(before), before.length]);
            const result = await apply(db, id, before);
            await run(db, 'COMMIT');
            active = false;
            return { ...result, backupVersionId: version.lastID };
        } catch (error) {
            if (active) await run(db, 'ROLLBACK').catch(() => {});
            throw error;
        } finally { await close(db); }
    }
    async function save(userId, items, { sessionId = null, sourceMessageId = null } = {}) {
        batchSize(items);
        const entries = [...new Map(items.map(item => {
            if (!item || typeof item.content !== 'string' || item.content.length < 2 || item.content.length > 360) throw new Error('invalid_memory_content');
            const key = buildMemoryKey(item.category, item.content);
            if (!key) throw new Error('invalid_memory_key');
            return [key, { ...item, key }];
        })).values()];
        return edit(userId, 'save', async (db, id) => {
            const savedMemories = [];
            for (const item of entries) {
                await run(db, `INSERT INTO user_memories
                    (user_id, memory_key, category, content, confidence, source_session_id, source_message_id, created_at, updated_at, deleted_at)
                    VALUES (?, ?, ?, ?, 1, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL)
                    ON CONFLICT(user_id, memory_key) DO UPDATE SET category = excluded.category, content = excluded.content,
                    confidence = 1, source_session_id = COALESCE(excluded.source_session_id, user_memories.source_session_id),
                    source_message_id = COALESCE(excluded.source_message_id, user_memories.source_message_id),
                    updated_at = CURRENT_TIMESTAMP, deleted_at = NULL`, [id, item.key, item.category, item.content, sessionId, sourceMessageId]);
                savedMemories.push(...await all(db, `SELECT id, category, content, confidence, source_session_id, source_message_id, created_at, updated_at
                    FROM user_memories WHERE user_id = ? AND memory_key = ? AND deleted_at IS NULL`, [id, item.key]));
            }
            return { savedMemories, savedCount: savedMemories.length, requestedCount: items.length };
        });
    }
    async function deleteIds(userId, ids) {
        batchSize(ids);
        if (ids.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('invalid_memory_ids');
        const unique = [...new Set(ids)];
        return edit(userId, 'delete', async (db, id, before) => {
            const deletedMemories = before.filter(memory => unique.includes(memory.id));
            const placeholders = unique.map(() => '?').join(',');
            const result = await run(db, `UPDATE user_memories SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                WHERE user_id = ? AND deleted_at IS NULL AND id IN (${placeholders})`, [id, ...unique]);
            return { deletedCount: result.changes, deletedMemories, missingIds: unique.filter(value => !deletedMemories.some(memory => memory.id === value)) };
        });
    }
    async function update(userId, memoryId, item) {
        if (!Number.isSafeInteger(memoryId) || memoryId <= 0) throw new Error('invalid_memory_ids');
        return edit(userId, 'update', async (db, id) => run(db, `UPDATE user_memories
            SET memory_key = ?, category = ?, content = ?, confidence = 1, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND user_id = ? AND deleted_at IS NULL`, [buildMemoryKey(item.category, item.content), item.category, item.content, memoryId, id]));
    }
    async function clear(userId) {
        return edit(userId, 'clear', async (db, id) => {
            const result = await run(db, `UPDATE user_memories SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                WHERE user_id = ? AND deleted_at IS NULL`, [id]);
            return { deletedCount: result.changes };
        });
    }
    async function versions(userId, { versionId = null, offset = 0 } = {}) {
        const id = userIdValue(userId);
        const db = await connect();
        try {
            if (versionId !== null) {
                if (!Number.isSafeInteger(versionId) || versionId <= 0) throw new Error('invalid_memory_version');
                const rows = await all(db, `SELECT id, operation, memory_count, created_at, memories_json
                    FROM user_memory_versions WHERE user_id = ? AND id = ?`, [id, versionId]);
                if (!rows.length) return null;
                const { memories_json, ...metadata } = rows[0];
                return { ...metadata, memories: JSON.parse(memories_json) };
            }
            return await all(db, `SELECT id, operation, memory_count, created_at FROM user_memory_versions
                WHERE user_id = ? ORDER BY id DESC LIMIT 50 OFFSET ?`, [id, offset]);
        } finally { await close(db); }
    }
    return { save, deleteIds, update, clear, versions };
}

module.exports = { createMemoryVersionStore, MAX_MEMORY_BATCH_SIZE };
