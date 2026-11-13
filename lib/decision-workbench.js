'use strict';

const MAX_PINS_PER_SESSION = 50;
const MAX_PIN_CONTENT_BYTES = 64 * 1024;

function fail(code, statusCode) {
    throw Object.assign(new Error(code), { code, statusCode });
}

function publicPin(row) {
    return {
        id: row.id,
        source_message_id: row.source_message_id,
        content: row.content,
        role: row.role,
        model: row.model,
        source_created_at: row.source_created_at,
        created_at: row.created_at,
        source_changed: Boolean(row.source_changed),
        source_missing: Boolean(row.source_missing)
    };
}

const PIN_QUERY = `
    SELECT p.*,
           m.id IS NULL AS source_missing,
           m.id IS NOT NULL AND (
               m.content IS NOT p.content OR m.role IS NOT p.role
               OR m.model IS NOT p.model OR m.created_at IS NOT p.source_created_at
           ) AS source_changed
    FROM decision_pins p
    JOIN sessions s ON s.id = p.session_id AND s.user_id = p.user_id
    LEFT JOIN messages m ON m.id = p.source_message_id AND m.session_id = p.session_id
    WHERE p.user_id = ? AND p.session_id = ?
      AND COALESCE(s.session_kind, 'chat') <> 'temporary'`;

function createDecisionWorkbenchService({ dbRunAsync, dbGetAsync, dbAllAsync } = {}) {
    let writeTail = Promise.resolve();
    function write(operation) {
        const result = writeTail.then(operation);
        writeTail = result.catch(() => undefined);
        return result;
    }
    for (const [name, value] of Object.entries({ dbRunAsync, dbGetAsync, dbAllAsync })) {
        if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
    }

    async function migrate() {
        await dbRunAsync('PRAGMA foreign_keys = ON');
        // No message FK: deleting a source must keep its snapshot and original ID.
        await dbRunAsync(`CREATE TABLE IF NOT EXISTS decision_pins (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            session_id TEXT NOT NULL,
            source_message_id INTEGER NOT NULL,
            content TEXT NOT NULL CHECK (
                typeof(content) = 'text'
                AND length(CAST(content AS BLOB)) <= ${MAX_PIN_CONTENT_BYTES}
            ),
            role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
            model TEXT,
            source_created_at DATETIME,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (session_id, user_id, source_message_id),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        )`);
    }

    async function requireSession(userId, sessionId) {
        const session = await dbGetAsync(
            'SELECT id, session_kind FROM sessions WHERE id = ? AND user_id = ?',
            [sessionId, userId]
        );
        if (!session) fail('session_not_found', 404);
        // Saved temporary conversations are persistent sessions and remain eligible.
        if (session.session_kind === 'temporary') fail('temporary_session_not_supported', 400);
    }

    async function listPins(userId, sessionId) {
        await requireSession(userId, sessionId);
        const rows = await dbAllAsync(PIN_QUERY + ' ORDER BY p.id ASC', [userId, sessionId]);
        return rows.map(publicPin);
    }

    async function createPin(userId, sessionId, sourceMessageId) {
        await requireSession(userId, sessionId);
        // Ownership, source copy and capacity check share one atomic SQLite statement.
        const insertion = await dbRunAsync(
            `INSERT INTO decision_pins
                (user_id, session_id, source_message_id, content, role, model, source_created_at)
             SELECT s.user_id, s.id, m.id, m.content, m.role, m.model, m.created_at
             FROM messages m JOIN sessions s ON s.id = m.session_id
             WHERE s.user_id = ? AND s.id = ? AND m.id = ?
               AND COALESCE(s.session_kind, 'chat') <> 'temporary'
               AND m.role IN ('user', 'assistant')
               AND typeof(m.content) = 'text'
               AND length(CAST(m.content AS BLOB)) <= ?
               AND (SELECT COUNT(*) FROM decision_pins p
                    WHERE p.session_id = s.id AND p.user_id = s.user_id) < ?
             ON CONFLICT (session_id, user_id, source_message_id) DO NOTHING`,
            [userId, sessionId, sourceMessageId, MAX_PIN_CONTENT_BYTES, MAX_PINS_PER_SESSION]
        );
        const existing = await dbGetAsync(
            PIN_QUERY + ' AND p.source_message_id = ?',
            [userId, sessionId, sourceMessageId]
        );
        // Repeated requests never replace a snapshot, even after the source changes/deletes.
        if (existing) return { pin: publicPin(existing), created: Boolean(insertion.changes) };

        await requireSession(userId, sessionId);
        const source = await dbGetAsync(
            `SELECT m.role, typeof(m.content) AS content_type,
                    length(CAST(m.content AS BLOB)) AS content_bytes
             FROM messages m JOIN sessions s ON s.id = m.session_id
             WHERE s.user_id = ? AND s.id = ? AND m.id = ?`,
            [userId, sessionId, sourceMessageId]
        );
        if (!source) fail('source_message_not_found', 404);
        if (!['user', 'assistant'].includes(source.role)) fail('invalid_source_role', 400);
        if (source.content_type !== 'text') fail('invalid_source_content', 400);
        if (source.content_bytes > MAX_PIN_CONTENT_BYTES) fail('pin_content_too_large', 413);
        fail('pin_limit_reached', 409);
    }

    async function deletePin(userId, sessionId, pinId) {
        await requireSession(userId, sessionId);
        const result = await dbRunAsync(
            `DELETE FROM decision_pins
             WHERE id = ? AND user_id = ? AND session_id = ?
               AND EXISTS (SELECT 1 FROM sessions s
                           WHERE s.id = decision_pins.session_id AND s.user_id = decision_pins.user_id
                             AND COALESCE(s.session_kind, 'chat') <> 'temporary')`,
            [pinId, userId, sessionId]
        );
        if (!result.changes) fail('pin_not_found', 404);
    }

    return Object.freeze({
        migrate,
        listPins,
        createPin: (...args) => write(() => createPin(...args)),
        deletePin: (...args) => write(() => deletePin(...args))
    });
}

module.exports = { createDecisionWorkbenchService, MAX_PINS_PER_SESSION, MAX_PIN_CONTENT_BYTES };
