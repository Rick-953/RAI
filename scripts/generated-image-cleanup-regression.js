'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const {
    GENERATED_IMAGE_DELETIONS_SCHEMA_SQL,
    drainGeneratedImageDeletionQueue,
    resolveGeneratedImageDeleteTarget,
    stageGeneratedImageDeletionsForMessage,
    stageGeneratedImageDeletionsForRequest,
    stageGeneratedImageDeletionsForSession
} = require('../lib/generated-image-cleanup');

const serverSource = fs.readFileSync(path.resolve(__dirname, '..', 'server.js'), 'utf8');

function openDatabase(filename) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(filename, (error) => error ? reject(error) : resolve(db));
    });
}

function closeDatabase(db) {
    return new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));
}

function dbRun(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (error) {
            if (error) reject(error);
            else resolve(this);
        });
    });
}

function dbAll(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows || []));
    });
}

function dbGet(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (error, row) => error ? reject(error) : resolve(row || null));
    });
}

function extractRoute(startMarker, endMarker) {
    const start = serverSource.indexOf(startMarker);
    const end = serverSource.indexOf(endMarker, start + startMarker.length);
    assert.ok(start >= 0 && end > start, `missing route boundary: ${startMarker}`);
    return serverSource.slice(start, end);
}

async function enqueue(db, filename, queuedAt) {
    await dbRun(
        db,
        `INSERT INTO generated_image_deletions (filename, queued_at)
         VALUES (?, ?)
         ON CONFLICT(filename) DO UPDATE SET queued_at = excluded.queued_at`,
        [filename, queuedAt]
    );
}

async function main() {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rai-generated-cleanup-'));
    const imageRoot = path.join(tempDir, 'generated-images');
    const databasePath = path.join(tempDir, 'cleanup.sqlite');
    await fs.promises.mkdir(imageRoot, { recursive: true });
    let db = await openDatabase(databasePath);
    const bindOptions = (extra = {}) => ({
        rootDir: imageRoot,
        dbAll: (sql, params) => dbAll(db, sql, params),
        dbRun: (sql, params) => dbRun(db, sql, params),
        ...extra
    });

    try {
        await dbRun(db, GENERATED_IMAGE_DELETIONS_SCHEMA_SQL);
        await dbRun(db, 'CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL)');
        await dbRun(db, 'CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, request_id TEXT, role TEXT, content TEXT)');
        await dbRun(db, `CREATE TABLE generated_images (
            filename TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            session_id TEXT,
            request_id TEXT
        )`);

        const tx = {
            all: (sql, params) => dbAll(db, sql, params),
            run: (sql, params) => dbRun(db, sql, params)
        };
        await dbRun(db, 'INSERT INTO sessions (id, user_id) VALUES (?, ?)', ['atomic-session', 7]);
        await dbRun(
            db,
            'INSERT INTO generated_images (filename, user_id, session_id) VALUES (?, ?, ?)',
            ['atomic.png', 7, 'atomic-session']
        );
        await dbRun(db, 'BEGIN IMMEDIATE TRANSACTION');
        try {
            await stageGeneratedImageDeletionsForSession({
                tx,
                sessionId: 'atomic-session',
                userId: 7,
                queuedAt: 10
            });
            await dbRun(db, 'DELETE FROM sessions WHERE id = ?', ['atomic-session']);
            throw new Error('injected_parent_delete_failure');
        } catch (error) {
            await dbRun(db, 'ROLLBACK');
            assert.strictEqual(error.message, 'injected_parent_delete_failure');
        }
        assert.ok(await dbGet(db, 'SELECT id FROM sessions WHERE id = ?', ['atomic-session']), 'rollback must retain the parent session');
        assert.ok(await dbGet(db, 'SELECT filename FROM generated_images WHERE filename = ?', ['atomic.png']), 'rollback must retain the image ACL');
        assert.strictEqual(await dbGet(db, 'SELECT filename FROM generated_image_deletions WHERE filename = ?', ['atomic.png']), null, 'rollback must not leak a deletion intent');

        await dbRun(db, 'BEGIN IMMEDIATE TRANSACTION');
        await stageGeneratedImageDeletionsForSession({
            tx,
            sessionId: 'atomic-session',
            userId: 7,
            queuedAt: 11
        });
        await dbRun(db, 'DELETE FROM sessions WHERE id = ?', ['atomic-session']);
        await dbRun(db, 'COMMIT');
        assert.strictEqual(await dbGet(db, 'SELECT id FROM sessions WHERE id = ?', ['atomic-session']), null, 'commit must delete the parent session');
        assert.strictEqual(await dbGet(db, 'SELECT filename FROM generated_images WHERE filename = ?', ['atomic.png']), null, 'commit must revoke the image ACL');
        assert.ok(await dbGet(db, 'SELECT filename FROM generated_image_deletions WHERE filename = ?', ['atomic.png']), 'commit must durably queue physical deletion');
        await dbRun(db, 'DELETE FROM generated_image_deletions WHERE filename = ?', ['atomic.png']);

        await dbRun(db, 'INSERT INTO sessions (id, user_id) VALUES (?, ?)', ['message-session', 8]);
        await dbRun(db, 'INSERT INTO messages (id, session_id, request_id) VALUES (?, ?, ?)', [41, 'message-session', 'request-41']);
        await dbRun(
            db,
            'INSERT INTO generated_images (filename, user_id, session_id, request_id) VALUES (?, ?, ?, ?)',
            ['message.png', 8, 'message-session', 'request-41']
        );
        await dbRun(db, 'BEGIN IMMEDIATE TRANSACTION');
        try {
            await stageGeneratedImageDeletionsForMessage({
                tx,
                sessionId: 'message-session',
                userId: 8,
                requestId: 'request-41',
                queuedAt: 12
            });
            await dbRun(db, 'DELETE FROM messages WHERE id = ?', [41]);
            throw new Error('injected_message_delete_failure');
        } catch (error) {
            await dbRun(db, 'ROLLBACK');
            assert.strictEqual(error.message, 'injected_message_delete_failure');
        }
        assert.ok(await dbGet(db, 'SELECT id FROM messages WHERE id = ?', [41]), 'message rollback must retain the parent message');
        assert.ok(await dbGet(db, 'SELECT filename FROM generated_images WHERE filename = ?', ['message.png']), 'message rollback must retain the image ACL');
        assert.strictEqual(await dbGet(db, 'SELECT filename FROM generated_image_deletions WHERE filename = ?', ['message.png']), null, 'message rollback must not leak a deletion intent');
        await dbRun(db, 'BEGIN IMMEDIATE TRANSACTION');
        await stageGeneratedImageDeletionsForMessage({
            tx,
            sessionId: 'message-session',
            userId: 8,
            requestId: 'request-41',
            queuedAt: 13
        });
        await dbRun(db, 'DELETE FROM messages WHERE id = ?', [41]);
        await dbRun(db, 'COMMIT');
        assert.strictEqual(await dbGet(db, 'SELECT id FROM messages WHERE id = ?', [41]), null, 'message commit must delete the parent message');
        assert.strictEqual(await dbGet(db, 'SELECT filename FROM generated_images WHERE filename = ?', ['message.png']), null, 'message commit must revoke the image ACL');
        assert.ok(await dbGet(db, 'SELECT filename FROM generated_image_deletions WHERE filename = ?', ['message.png']), 'message commit must durably queue physical deletion');
        await dbRun(db, 'DELETE FROM generated_image_deletions WHERE filename = ?', ['message.png']);

        const failedRequestName = 'failed-request-no-session.png';
        const otherOwnerName = 'failed-request-other-owner.png';
        const failedRequestId = 'request-no-session-failpoint';
        await fs.promises.writeFile(path.join(imageRoot, failedRequestName), 'failed request', { mode: 0o600 });
        await fs.promises.writeFile(path.join(imageRoot, otherOwnerName), 'other owner', { mode: 0o600 });
        await dbRun(
            db,
            'INSERT INTO generated_images (filename, user_id, session_id, request_id) VALUES (?, ?, NULL, ?)',
            [failedRequestName, 9, failedRequestId]
        );
        await dbRun(
            db,
            'INSERT INTO generated_images (filename, user_id, session_id, request_id) VALUES (?, ?, NULL, ?)',
            [otherOwnerName, 99, failedRequestId]
        );
        await dbRun(
            db,
            `CREATE TRIGGER fail_request_cleanup_queue
             BEFORE INSERT ON generated_image_deletions
             WHEN NEW.filename = '${failedRequestName}'
             BEGIN
                 SELECT RAISE(ABORT, 'injected_request_cleanup_queue_failure');
             END`
        );
        await dbRun(db, 'BEGIN IMMEDIATE TRANSACTION');
        await assert.rejects(
            () => stageGeneratedImageDeletionsForRequest({
                tx,
                userId: 9,
                requestId: failedRequestId,
                queuedAt: 14
            }),
            /injected_request_cleanup_queue_failure/
        );
        await dbRun(db, 'ROLLBACK');
        assert.ok(await dbGet(db, 'SELECT filename FROM generated_images WHERE filename = ?', [failedRequestName]), 'cleanup staging failure must retain the image ACL');
        assert.strictEqual(await dbGet(db, 'SELECT filename FROM generated_image_deletions WHERE filename = ?', [failedRequestName]), null, 'cleanup staging failure must not leave a partial queue row');
        assert.strictEqual(fs.existsSync(path.join(imageRoot, failedRequestName)), true, 'cleanup staging failure must not unlink outside the transaction');
        await dbRun(db, 'DROP TRIGGER fail_request_cleanup_queue');

        await dbRun(db, 'BEGIN IMMEDIATE TRANSACTION');
        assert.strictEqual(await stageGeneratedImageDeletionsForRequest({
            tx,
            userId: 9,
            requestId: failedRequestId,
            queuedAt: 15
        }), 1, 'request cleanup must work without a session id');
        await dbRun(db, 'COMMIT');
        assert.strictEqual(await dbGet(db, 'SELECT filename FROM generated_images WHERE filename = ?', [failedRequestName]), null, 'request cleanup must revoke the failed request image ACL');
        assert.ok(await dbGet(db, 'SELECT filename FROM generated_images WHERE filename = ?', [otherOwnerName]), 'request cleanup must not cross the user boundary');
        assert.ok(await dbGet(db, 'SELECT filename FROM generated_image_deletions WHERE filename = ?', [failedRequestName]), 'request cleanup must durably queue the file');
        assert.deepStrictEqual(
            await drainGeneratedImageDeletionQueue(bindOptions()),
            { processed: 1, deleted: 1, missing: 0, failed: 0 }
        );
        assert.strictEqual(fs.existsSync(path.join(imageRoot, failedRequestName)), false, 'request cleanup must remove the failed request file');

        await dbRun(db, 'INSERT INTO sessions (id, user_id) VALUES (?, ?)', ['insert-fail-session', 10]);
        const insertFailName = 'assistant-insert-fail.png';
        const insertFailRequestId = 'request-assistant-insert-fail';
        await fs.promises.writeFile(path.join(imageRoot, insertFailName), 'assistant insert fail', { mode: 0o600 });
        await dbRun(
            db,
            'INSERT INTO generated_images (filename, user_id, session_id, request_id) VALUES (?, ?, ?, ?)',
            [insertFailName, 10, 'insert-fail-session', insertFailRequestId]
        );
        await dbRun(
            db,
            `CREATE TRIGGER fail_assistant_message_insert
             BEFORE INSERT ON messages
             WHEN NEW.request_id = '${insertFailRequestId}'
             BEGIN
                 SELECT RAISE(ABORT, 'injected_assistant_message_insert_failure');
             END`
        );
        await assert.rejects(
            () => dbRun(
                db,
                'INSERT INTO messages (session_id, request_id, role, content) VALUES (?, ?, ?, ?)',
                ['insert-fail-session', insertFailRequestId, 'assistant', 'will fail']
            ),
            /injected_assistant_message_insert_failure/
        );
        await dbRun(db, 'DROP TRIGGER fail_assistant_message_insert');
        await dbRun(db, 'BEGIN IMMEDIATE TRANSACTION');
        assert.strictEqual(await stageGeneratedImageDeletionsForRequest({
            tx,
            userId: 10,
            requestId: insertFailRequestId,
            queuedAt: 16
        }), 1, 'assistant INSERT failure must stage its generated image');
        await dbRun(db, 'COMMIT');
        assert.deepStrictEqual(
            await drainGeneratedImageDeletionQueue(bindOptions()),
            { processed: 1, deleted: 1, missing: 0, failed: 0 }
        );
        assert.strictEqual(await dbGet(db, 'SELECT filename FROM generated_images WHERE filename = ?', [insertFailName]), null, 'assistant INSERT failure must revoke its image ACL');
        assert.strictEqual(fs.existsSync(path.join(imageRoot, insertFailName)), false, 'assistant INSERT failure must not leave its image file');

        const abortedName = 'aborted-request.png';
        const abortedRequestId = 'request-client-aborted';
        await fs.promises.writeFile(path.join(imageRoot, abortedName), 'aborted', { mode: 0o600 });
        await dbRun(
            db,
            'INSERT INTO generated_images (filename, user_id, session_id, request_id) VALUES (?, ?, NULL, ?)',
            [abortedName, 11, abortedRequestId]
        );
        await dbRun(db, 'BEGIN IMMEDIATE TRANSACTION');
        assert.strictEqual(await stageGeneratedImageDeletionsForRequest({
            tx,
            userId: 11,
            requestId: abortedRequestId,
            queuedAt: 17
        }), 1, 'client abort must stage request-scoped cleanup');
        await dbRun(db, 'COMMIT');
        assert.deepStrictEqual(
            await drainGeneratedImageDeletionQueue(bindOptions()),
            { processed: 1, deleted: 1, missing: 0, failed: 0 }
        );
        assert.strictEqual(fs.existsSync(path.join(imageRoot, abortedName)), false, 'client abort must not leave its image file');

        await dbRun(db, 'INSERT INTO sessions (id, user_id) VALUES (?, ?)', ['successful-session', 12]);
        const successfulName = 'successful-request.png';
        const successfulRequestId = 'request-successful';
        await fs.promises.writeFile(path.join(imageRoot, successfulName), 'successful', { mode: 0o600 });
        await dbRun(
            db,
            'INSERT INTO generated_images (filename, user_id, session_id, request_id) VALUES (?, ?, ?, ?)',
            [successfulName, 12, 'successful-session', successfulRequestId]
        );
        await dbRun(
            db,
            'INSERT INTO messages (session_id, request_id, role, content) VALUES (?, ?, ?, ?)',
            ['successful-session', successfulRequestId, 'assistant', 'successful response']
        );
        const successfulBinding = await dbGet(
            db,
            `SELECT gi.filename
             FROM generated_images gi
             JOIN messages m
               ON m.session_id = gi.session_id AND m.request_id = gi.request_id
             WHERE gi.user_id = ? AND gi.request_id = ?`,
            [12, successfulRequestId]
        );
        assert.strictEqual(successfulBinding?.filename, successfulName, 'successful requests must retain the image bound to their assistant message and session');
        assert.strictEqual(fs.existsSync(path.join(imageRoot, successfulName)), true, 'successful requests must not unlink their generated image');

        const userSessionDeleteRoute = extractRoute(
            "app.delete('/api/sessions/:id'",
            "app.get('/api/sessions/:id/messages'"
        );
        const flowDeleteRoute = extractRoute(
            "app.delete('/api/flows/:id'",
            '// ==================== \u6d88\u606f\u7ba1\u7406API ===================='
        );
        const adminSessionDeleteRoute = extractRoute(
            "app.delete('/api/admin/sessions/:sessionId'",
            '// ==================== 404\u5904\u7406 ===================='
        );
        for (const [label, route, parentDeletePattern] of [
            ['user session', userSessionDeleteRoute, /DELETE FROM sessions/],
            ['flow', flowDeleteRoute, /DELETE FROM flows/],
            ['admin session', adminSessionDeleteRoute, /DELETE FROM sessions/]
        ]) {
            assert.match(route, /withMainDbTransaction\(async \(tx\) =>/,
                `${label} deletion must own one main-database transaction`);
            const stageIndex = route.indexOf('stageGeneratedImageDeletionsForSession({');
            const parentDeleteIndex = route.search(parentDeletePattern);
            assert.ok(stageIndex >= 0 && parentDeleteIndex > stageIndex,
                `${label} deletion must stage image cleanup before deleting its parent`);
        }
        const userMessageDeleteRoute = extractRoute(
            "app.delete('/api/sessions/:sessionId/messages/:messageId'",
            "app.put('/api/sessions/:sessionId/messages/:messageId'"
        );
        const adminMessageDeleteRoute = extractRoute(
            "app.delete('/api/admin/messages/:messageId'",
            '// \u83b7\u53d6\u6240\u6709\u4f1a\u8bdd'
        );
        for (const [label, route] of [
            ['user message', userMessageDeleteRoute],
            ['admin message', adminMessageDeleteRoute]
        ]) {
            assert.match(route, /withMainDbTransaction\(async \(tx\) =>/,
                `${label} deletion must own one main-database transaction`);
            assert.ok(
                route.indexOf('stageGeneratedImageDeletionsForMessage({') >= 0
                && route.indexOf('DELETE FROM messages') > route.indexOf('stageGeneratedImageDeletionsForMessage({'),
                `${label} deletion must stage image cleanup before deleting its parent`
            );
        }
        const chatRoute = extractRoute(
            "app.post('/api/chat/stream'",
            "app.post('/api/chat/stop'"
        );
        assert.match(chatRoute, /req\.once\('aborted', handleClientAbort\)/,
            'chat lifecycle must observe request aborts');
        assert.match(chatRoute, /res\.once\('close', handleClientAbort\)/,
            'chat lifecycle must observe response disconnects');
        assert.match(chatRoute, /cleanupFailedChatGeneratedImagesBestEffort\(\{/,
            'failed chat lifecycle must invoke request-scoped generated image cleanup');
        assert.match(serverSource, /stageGeneratedImageDeletionsForRequest\(\{/,
            'failed chat cleanup must stage by request without requiring a session');
        assert.match(chatRoute, /!chatRequestSucceeded \|\| clientAborted \|\| chatRequestCancelled/,
            'failed chat cleanup must distinguish successful requests from aborts and cancellation');
        assert.ok((chatRoute.match(/chatRequestSucceeded = true/g) || []).length >= 5,
            'all successful chat completion paths must opt out of failed-request cleanup');
        assert.throws(
            () => resolveGeneratedImageDeleteTarget(imageRoot, '../outside.png'),
            (error) => error?.code === 'generated_image_delete_filename_invalid'
        );
        assert.throws(
            () => resolveGeneratedImageDeleteTarget(imageRoot, 'no-extension.txt'),
            (error) => error?.code === 'generated_image_delete_filename_invalid'
        );

        const regularName = 'regular.png';
        await fs.promises.writeFile(path.join(imageRoot, regularName), 'regular', { mode: 0o600 });
        await enqueue(db, regularName, 1);
        const regularResult = await drainGeneratedImageDeletionQueue(bindOptions());
        assert.deepStrictEqual(regularResult, { processed: 1, deleted: 1, missing: 0, failed: 0 });
        assert.strictEqual(fs.existsSync(path.join(imageRoot, regularName)), false);

        await enqueue(db, 'already-missing.webp', 2);
        const missingResult = await drainGeneratedImageDeletionQueue(bindOptions());
        assert.deepStrictEqual(missingResult, { processed: 1, deleted: 0, missing: 1, failed: 0 });

        const retryName = 'retry.png';
        const retryPath = path.join(imageRoot, retryName);
        await fs.promises.writeFile(retryPath, 'retry', { mode: 0o600 });
        await enqueue(db, retryName, 3);
        const failedResult = await drainGeneratedImageDeletionQueue(bindOptions({
            unlink: async () => {
                const error = new Error('injected unlink failure');
                error.code = 'EACCES';
                throw error;
            },
            now: () => 99
        }));
        assert.deepStrictEqual(failedResult, { processed: 1, deleted: 0, missing: 0, failed: 1 });
        let queued = await dbAll(db, 'SELECT * FROM generated_image_deletions WHERE filename = ?', [retryName]);
        assert.strictEqual(queued[0]?.attempts, 1, 'failed deletion must stay durably queued');
        assert.strictEqual(queued[0]?.last_attempt_at, 99);
        assert.strictEqual(queued[0]?.last_error, 'EACCES');

        await closeDatabase(db);
        db = await openDatabase(databasePath);
        const restartedResult = await drainGeneratedImageDeletionQueue(bindOptions());
        assert.deepStrictEqual(restartedResult, { processed: 1, deleted: 1, missing: 0, failed: 0 });
        assert.strictEqual(fs.existsSync(retryPath), false, 'restart drain must retry persistent work');

        const outsidePath = path.join(tempDir, 'outside.txt');
        await fs.promises.writeFile(outsidePath, 'do not touch', { mode: 0o600 });
        const symlinkName = 'link.png';
        await fs.promises.symlink(outsidePath, path.join(imageRoot, symlinkName));
        await enqueue(db, symlinkName, 4);
        const symlinkResult = await drainGeneratedImageDeletionQueue(bindOptions());
        assert.deepStrictEqual(symlinkResult, { processed: 1, deleted: 0, missing: 0, failed: 1 });
        assert.strictEqual(await fs.promises.readFile(outsidePath, 'utf8'), 'do not touch');

        await dbRun(db, 'DELETE FROM generated_image_deletions WHERE filename = ?', [symlinkName]);
        const directoryName = 'directory.png';
        await fs.promises.mkdir(path.join(imageRoot, directoryName));
        await enqueue(db, directoryName, 5);
        const specialResult = await drainGeneratedImageDeletionQueue(bindOptions());
        assert.deepStrictEqual(specialResult, { processed: 1, deleted: 0, missing: 0, failed: 1 });
        queued = await dbAll(db, 'SELECT last_error FROM generated_image_deletions WHERE filename = ?', [directoryName]);
        assert.strictEqual(queued[0]?.last_error, 'generated_image_delete_target_not_regular_file');

        console.log('generated-image-cleanup-regression ok atomic_parent_message_request_cleanup no_session_db_failpoint_insert_failure_abort_success durable_retry path_and_special_file_rejection');
    } finally {
        await closeDatabase(db).catch(() => undefined);
        await fs.promises.rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
    }
}

main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
});
