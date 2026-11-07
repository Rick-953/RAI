'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3');
const { createMemoryVersionStore } = require('../lib/memory-version-store');
const { validateSaveMemoryRequest, validateManualMemoryBatch } = require('../lib/memory-tool-policy');

async function main() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rai-memory-versions-'));
    const filename = path.join(directory, 'test.db');
    const openDatabase = () => new Promise((resolve, reject) => {
        const db = new sqlite3.Database(filename, error => error ? reject(error) : resolve(db));
    });
    const db = await openDatabase();
    const exec = sql => new Promise((resolve, reject) => db.exec(sql, error => error ? reject(error) : resolve()));
    const all = (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
    const buildMemoryKey = (category, content) => category + ':' + content.toLowerCase().replace(/\s/g, '');
    const store = createMemoryVersionStore({ openDatabase, buildMemoryKey });
    try {
        await exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
            CREATE TABLE users (id INTEGER PRIMARY KEY);
            INSERT INTO users VALUES (1), (2);
            CREATE TABLE user_memories (
                id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                memory_key TEXT NOT NULL, category TEXT NOT NULL, content TEXT NOT NULL CHECK(content != 'force_failure'),
                confidence REAL, source_session_id TEXT, source_message_id INTEGER,
                created_at TEXT, updated_at TEXT, deleted_at TEXT, UNIQUE(user_id, memory_key));`);
        const items = Array.from({ length: 500 }, (_, index) => ({ category: 'work', content: `Durable project ${index}`,
            evidence: `Please remember project ${index}`, reason: 'Relevant to future work' }));
        const quotes = items.map(item => item.evidence);
        assert.equal(validateSaveMemoryRequest({ memories: items }, quotes).ok, true);
        assert.equal(validateSaveMemoryRequest({ memories: [...items, items[0]] }, quotes).code, 'memory_batch_size');
        assert.equal(validateSaveMemoryRequest({ memories: [] }, quotes).code, 'memory_batch_size');
        assert.equal(validateSaveMemoryRequest({ memories: [...items.slice(0, 499), { ...items[499], evidence: 'Invented quote' }] }, quotes).failedIndex, 499);
        assert.equal(validateSaveMemoryRequest({ memories: [{ ...items[0], content: 'my API key is abc' }] }, quotes).code, 'memory_sensitive_content');
        assert.equal(validateManualMemoryBatch(items).ok, true);
        assert.equal(validateManualMemoryBatch([...items, items[0]]).ok, false);
        assert.equal(validateManualMemoryBatch([{ content: 'x'.repeat(361) }]).ok, false);

        const saved = await store.save(1, items);
        assert.equal(saved.savedCount, 500);
        assert.equal((await all('SELECT * FROM user_memories WHERE user_id = 1 AND deleted_at IS NULL')).length, 500);
        let versions = await store.versions(1);
        assert.equal(versions.length, 1, 'one backup per 500-item batch');
        assert.equal(versions[0].memory_count, 0, 'snapshot is the state BEFORE the first save');
        assert.deepEqual((await store.versions(1, { versionId: saved.backupVersionId })).memories, []);
        assert.equal(await store.versions(2, { versionId: saved.backupVersionId }), null, 'version detail is account scoped');

        const duplicate = await store.save(1, [items[0], items[0]]);
        assert.equal(duplicate.savedCount, 1, 'duplicate upserts count unique facts');
        assert.equal((await store.versions(1, { versionId: duplicate.backupVersionId })).memories.length, 500);
        const versionCount = (await store.versions(1)).length;
        await assert.rejects(store.save(1, [...items, items[0]]), /memory_batch_size/);
        await assert.rejects(store.save(1, [{ category: 'work', content: 'new fact before failure' }, { category: 'work', content: 'force_failure' }]));
        assert.equal((await store.versions(1)).length, versionCount, 'failed write rolls back its backup too');
        assert.equal((await all("SELECT id FROM user_memories WHERE content = 'new fact before failure'")).length, 0, 'failed batch has no partial write');

        const other = await store.save(2, [{ category: 'work', content: 'Private account two memory' }]);
        const mixed = await store.deleteIds(1, [saved.savedMemories[0].id, other.savedMemories[0].id]);
        assert.equal(mixed.deletedCount, 1);
        assert.deepEqual(mixed.missingIds, [other.savedMemories[0].id]);
        assert.equal((await all('SELECT id FROM user_memories WHERE user_id = 2 AND deleted_at IS NULL')).length, 1);
        await store.save(1, [items[0]]);
        const beforeDelete = await all('SELECT id FROM user_memories WHERE user_id = 1 AND deleted_at IS NULL');
        await assert.rejects(store.deleteIds(1, [...beforeDelete.map(row => row.id), other.savedMemories[0].id]), /memory_batch_size/);
        const removed = await store.deleteIds(1, beforeDelete.map(row => row.id));
        assert.equal(removed.deletedCount, 500);
        assert.equal((await store.versions(1, { versionId: removed.backupVersionId })).memories.length, 500);
        assert.equal((await all('SELECT id FROM user_memories WHERE user_id = 1 AND deleted_at IS NULL')).length, 0);

        const single = await store.save(1, [{ category: 'work', content: 'Original memory' }]);
        const updated = await store.update(1, single.savedMemories[0].id, { category: 'work', content: 'Updated memory' });
        assert.equal((await store.versions(1, { versionId: updated.backupVersionId })).memories[0].content, 'Original memory');
        const cleared = await store.clear(1);
        assert.equal(cleared.deletedCount, 1);
        assert.equal((await store.versions(1, { versionId: cleared.backupVersionId })).memories[0].content, 'Updated memory');
        const concurrent = await Promise.all([
            store.save(1, [{ category: 'work', content: 'Concurrent project A' }]),
            store.save(1, [{ category: 'work', content: 'Concurrent project B' }])
        ]);
        const snapshots = await Promise.all(concurrent.map(result => store.versions(1, { versionId: result.backupVersionId })));
        assert.deepEqual(snapshots.map(version => version.memories.length).sort(), [0, 1], 'concurrent edits each back up the state immediately before their own edit');
        assert.equal((await all('SELECT id FROM user_memories WHERE user_id = 1 AND deleted_at IS NULL')).length, 2);
        assert.equal((await store.versions(2)).length, 1, 'other account has only its own save version');
        await exec('DELETE FROM users WHERE id = 1');
        assert.equal((await all('SELECT id FROM user_memory_versions WHERE user_id = 1')).length, 0, 'account deletion removes backups');
        console.log('PASS: 500 save/delete; 501 rejection; evidence/secret gates; deduplication; pre-edit backups; atomic rollback; account isolation; update/clear backups; account-deletion cleanup.');
    } finally {
        await new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
        const resolved = fs.realpathSync(directory);
        assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
        assert.ok(path.basename(resolved).startsWith('rai-memory-versions-'));
        fs.rmSync(resolved, { recursive: true });
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
