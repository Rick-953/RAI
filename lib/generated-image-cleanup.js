'use strict';

const fs = require('fs');
const path = require('path');

const GENERATED_IMAGE_DELETIONS_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS generated_image_deletions (
    filename TEXT PRIMARY KEY,
    queued_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_attempt_at INTEGER,
    last_error TEXT
)`;

const GENERATED_IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);

function cleanupError(code, details = {}) {
    const error = new Error(code);
    error.code = code;
    Object.assign(error, details);
    return error;
}

function resolveGeneratedImageDeleteTarget(rootDir, filename) {
    const rawFilename = String(filename || '');
    const safeFilename = path.basename(rawFilename);
    const extension = path.extname(rawFilename).toLowerCase().slice(1);
    if (
        !rawFilename
        || rawFilename.length > 255
        || rawFilename !== safeFilename
        || safeFilename === '.'
        || safeFilename === '..'
        || !GENERATED_IMAGE_EXTENSIONS.has(extension)
    ) {
        throw cleanupError('generated_image_delete_filename_invalid');
    }

    const rootPath = path.resolve(String(rootDir || ''));
    const filePath = path.resolve(rootPath, safeFilename);
    if (!rootPath || !filePath.startsWith(`${rootPath}${path.sep}`)) {
        throw cleanupError('generated_image_delete_path_escape');
    }
    return { filename: safeFilename, rootPath, filePath };
}

function compactCleanupError(error) {
    const value = String(error?.code || error?.message || 'generated_image_delete_failed')
        .replace(/[\r\n\0]/g, ' ')
        .slice(0, 240);
    return value || 'generated_image_delete_failed';
}

async function stageGeneratedImageDeletionsForSession(options = {}) {
    const tx = options.tx;
    if (!tx || typeof tx.all !== 'function' || typeof tx.run !== 'function') {
        throw cleanupError('generated_image_delete_transaction_required');
    }
    const sessionId = String(options.sessionId || '').trim();
    if (!sessionId) return 0;
    const hasOwner = options.userId !== undefined && options.userId !== null;
    const ownerClause = hasOwner ? ' AND user_id = ?' : '';
    const params = hasOwner ? [sessionId, Number(options.userId)] : [sessionId];
    const queuedAt = Number.isFinite(Number(options.queuedAt)) ? Number(options.queuedAt) : Date.now();
    const rows = await tx.all(
        `SELECT filename FROM generated_images WHERE session_id = ?${ownerClause}`,
        params
    );
    for (const row of rows) {
        await tx.run(
            `INSERT INTO generated_image_deletions (filename, queued_at)
             VALUES (?, ?)
             ON CONFLICT(filename) DO NOTHING`,
            [String(row.filename || ''), queuedAt]
        );
    }
    await tx.run(
        `DELETE FROM generated_images WHERE session_id = ?${ownerClause}`,
        params
    );
    return rows.length;
}

async function stageGeneratedImageDeletionsForMessage(options = {}) {
    const tx = options.tx;
    if (!tx || typeof tx.all !== 'function' || typeof tx.run !== 'function') {
        throw cleanupError('generated_image_delete_transaction_required');
    }
    const sessionId = String(options.sessionId || '').trim();
    if (!sessionId) return 0;
    const requestId = String(options.requestId || '').trim().slice(0, 160);
    const filenames = [...new Set((Array.isArray(options.filenames) ? options.filenames : [])
        .map((value) => String(value || '').trim())
        .filter((value) => {
            try {
                resolveGeneratedImageDeleteTarget('/generated-images-root', value);
                return true;
            } catch (error) {
                return false;
            }
        }))];
    if (!requestId && filenames.length === 0) return 0;

    const hasOwner = options.userId !== undefined && options.userId !== null;
    const selectorParts = [];
    const params = [sessionId];
    if (hasOwner) params.push(Number(options.userId));
    if (requestId) {
        selectorParts.push('request_id = ?');
        params.push(requestId);
    }
    if (filenames.length > 0) {
        selectorParts.push(`filename IN (${filenames.map(() => '?').join(', ')})`);
        params.push(...filenames);
    }
    const ownerClause = hasOwner ? ' AND user_id = ?' : '';
    const rows = await tx.all(
        `SELECT filename FROM generated_images
         WHERE session_id = ?${ownerClause}
           AND (${selectorParts.join(' OR ')})`,
        params
    );
    const queuedAt = Number.isFinite(Number(options.queuedAt)) ? Number(options.queuedAt) : Date.now();
    for (const row of rows) {
        const filename = String(row.filename || '');
        await tx.run(
            `INSERT INTO generated_image_deletions (filename, queued_at)
             VALUES (?, ?)
             ON CONFLICT(filename) DO NOTHING`,
            [filename, queuedAt]
        );
        await tx.run(
            `DELETE FROM generated_images
             WHERE filename = ? AND session_id = ?${ownerClause}`,
            hasOwner ? [filename, sessionId, Number(options.userId)] : [filename, sessionId]
        );
    }
    return rows.length;
}

async function stageGeneratedImageDeletionsForRequest(options = {}) {
    const tx = options.tx;
    if (!tx || typeof tx.all !== 'function' || typeof tx.run !== 'function') {
        throw cleanupError('generated_image_delete_transaction_required');
    }
    const userId = Number(options.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
        throw cleanupError('generated_image_delete_user_required');
    }
    const requestId = String(options.requestId || '').trim();
    if (!requestId) return 0;
    if (requestId.length > 160) {
        throw cleanupError('generated_image_delete_request_invalid');
    }

    const rows = await tx.all(
        `SELECT filename FROM generated_images
         WHERE user_id = ? AND request_id = ?`,
        [userId, requestId]
    );
    const queuedAt = Number.isFinite(Number(options.queuedAt)) ? Number(options.queuedAt) : Date.now();
    for (const row of rows) {
        await tx.run(
            `INSERT INTO generated_image_deletions (filename, queued_at)
             VALUES (?, ?)
             ON CONFLICT(filename) DO NOTHING`,
            [String(row.filename || ''), queuedAt]
        );
    }
    await tx.run(
        `DELETE FROM generated_images
         WHERE user_id = ? AND request_id = ?`,
        [userId, requestId]
    );
    return rows.length;
}

async function drainGeneratedImageDeletionQueue(options = {}) {
    const dbAll = options.dbAll;
    const dbRun = options.dbRun;
    if (typeof dbAll !== 'function' || typeof dbRun !== 'function') {
        throw cleanupError('generated_image_delete_database_required');
    }
    const rootDir = options.rootDir;
    const lstat = options.lstat || fs.promises.lstat.bind(fs.promises);
    const unlink = options.unlink || fs.promises.unlink.bind(fs.promises);
    const now = typeof options.now === 'function' ? options.now : Date.now;
    const limit = Math.max(1, Math.min(Number(options.limit) || 200, 1000));
    const rows = await dbAll(
        `SELECT filename, queued_at, attempts
         FROM generated_image_deletions
         ORDER BY queued_at ASC, filename ASC
         LIMIT ?`,
        [limit]
    );
    const result = { processed: rows.length, deleted: 0, missing: 0, failed: 0 };

    for (const row of rows) {
        let missing = false;
        try {
            const target = resolveGeneratedImageDeleteTarget(rootDir, row.filename);
            let stat;
            try {
                stat = await lstat(target.filePath);
            } catch (error) {
                if (error?.code !== 'ENOENT') throw error;
                missing = true;
            }
            if (!missing) {
                if (stat.isSymbolicLink() || !stat.isFile() || Number(stat.nlink || 1) !== 1) {
                    throw cleanupError('generated_image_delete_target_not_regular_file');
                }
                await unlink(target.filePath);
            }
            await dbRun(
                'DELETE FROM generated_image_deletions WHERE filename = ? AND queued_at = ?',
                [row.filename, row.queued_at]
            );
            if (missing) result.missing += 1;
            else result.deleted += 1;
        } catch (error) {
            result.failed += 1;
            await dbRun(
                `UPDATE generated_image_deletions
                 SET attempts = attempts + 1,
                     last_attempt_at = ?,
                     last_error = ?
                 WHERE filename = ? AND queued_at = ?`,
                [now(), compactCleanupError(error), row.filename, row.queued_at]
            );
            if (typeof options.onError === 'function') options.onError(error, row);
        }
    }
    return result;
}

module.exports = {
    GENERATED_IMAGE_DELETIONS_SCHEMA_SQL,
    drainGeneratedImageDeletionQueue,
    resolveGeneratedImageDeleteTarget,
    stageGeneratedImageDeletionsForMessage,
    stageGeneratedImageDeletionsForRequest,
    stageGeneratedImageDeletionsForSession
};
