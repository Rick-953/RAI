'use strict';

const crypto = require('crypto');

const SOFTWARE_CLIENT_KEY_PREFIX = 'rai_app_v1';
const SOFTWARE_CLIENT_SCOPE = 'user_api';
const SOFTWARE_CLIENT_KEY_ID_PATTERN = /^[A-Za-z0-9_-]{16}$/;
const SOFTWARE_CLIENT_KEY_PATTERN = /^rai_app_v1_([A-Za-z0-9_-]{16})_([A-Za-z0-9_-]{43})$/;
const SOFTWARE_CLIENT_HASH_PATTERN = /^[a-f0-9]{64}$/;
const DUMMY_KEY_HASH = crypto.createHash('sha256').update('rai-software-client-missing-v1').digest();

function runAsync(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(error) {
            if (error) reject(error);
            else resolve({ changes: Number(this.changes || 0), lastID: this.lastID });
        });
    });
}

function getAsync(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (error, row) => {
            if (error) reject(error);
            else resolve(row || null);
        });
    });
}

function allAsync(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (error, rows) => {
            if (error) reject(error);
            else resolve(Array.isArray(rows) ? rows : []);
        });
    });
}

function normalizeText(value, label, maxLength) {
    const normalized = String(value || '')
        .normalize('NFKC')
        .replace(/[\u0000-\u001F\u007F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!normalized || normalized.length > maxLength) {
        throw new TypeError(`${label} must contain 1-${maxLength} safe characters`);
    }
    return normalized;
}

function normalizePlatform(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (!/^[a-z][a-z0-9_-]{1,31}$/.test(normalized)) {
        throw new TypeError('platform must be a 2-32 character identifier');
    }
    return normalized;
}

function normalizePackageName(value) {
    const normalized = String(value || '').trim();
    if (!normalized) return null;
    if (normalized.length > 255 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(normalized)) {
        throw new TypeError('packageName must be a safe package identifier');
    }
    return normalized;
}

function normalizeScopes(scopes = [SOFTWARE_CLIENT_SCOPE]) {
    if (!Array.isArray(scopes) || scopes.length !== 1 || scopes[0] !== SOFTWARE_CLIENT_SCOPE) {
        throw new TypeError(`software client scopes are fixed to ${SOFTWARE_CLIENT_SCOPE}`);
    }
    return Object.freeze([SOFTWARE_CLIENT_SCOPE]);
}

function parseStoredScopes(value) {
    try {
        return normalizeScopes(JSON.parse(String(value || '')));
    } catch (_error) {
        return null;
    }
}

function normalizeKeyId(value) {
    const normalized = String(value || '').trim();
    if (!SOFTWARE_CLIENT_KEY_ID_PATTERN.test(normalized)) {
        throw new TypeError('keyId must be a 16 character base64url identifier');
    }
    return normalized;
}

function parseSoftwareClientKey(value) {
    if (typeof value !== 'string' || value.length > 128) return null;
    const match = value.match(SOFTWARE_CLIENT_KEY_PATTERN);
    if (!match) return null;
    const canonical = `${SOFTWARE_CLIENT_KEY_PREFIX}_${match[1]}_${match[2]}`;
    if (canonical !== value) return null;
    return Object.freeze({ rawKey: canonical, keyId: match[1], secret: match[2] });
}

function hashSoftwareClientKey(value) {
    return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest();
}

function normalizeEpochSeconds(now) {
    const milliseconds = Number(now());
    if (!Number.isFinite(milliseconds)) throw new TypeError('now() must return epoch milliseconds');
    return Math.floor(milliseconds / 1000);
}

function rowToClient(row) {
    if (!row) return null;
    const scopes = parseStoredScopes(row.scopes);
    if (!scopes) return null;
    return Object.freeze({
        keyId: String(row.key_id),
        name: String(row.name),
        platform: String(row.platform),
        scopes,
        packageName: row.package_name ? String(row.package_name) : null,
        createdAt: Number(row.created_at),
        lastUsedAt: row.last_used_at === null || row.last_used_at === undefined
            ? null
            : Number(row.last_used_at),
        revokedAt: row.revoked_at === null || row.revoked_at === undefined
            ? null
            : Number(row.revoked_at),
        active: row.revoked_at === null || row.revoked_at === undefined
    });
}

async function migrateSoftwareClientSchema(db) {
    if (!db || typeof db.run !== 'function' || typeof db.get !== 'function' || typeof db.all !== 'function') {
        throw new TypeError('A sqlite3 callback-style Database is required');
    }
    await runAsync(db, `CREATE TABLE IF NOT EXISTS software_clients (
        key_id TEXT PRIMARY KEY,
        key_hash TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        platform TEXT NOT NULL,
        scopes TEXT NOT NULL,
        package_name TEXT,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at INTEGER
    )`);
    await runAsync(
        db,
        'CREATE INDEX IF NOT EXISTS idx_software_clients_active ON software_clients(revoked_at, platform, created_at DESC)'
    );

    const columns = new Set((await allAsync(db, 'PRAGMA table_info(software_clients)')).map((row) => row.name));
    for (const required of [
        'key_id', 'key_hash', 'name', 'platform', 'scopes', 'package_name',
        'created_at', 'last_used_at', 'revoked_at'
    ]) {
        if (!columns.has(required)) throw new Error(`software_clients_missing_column:${required}`);
    }
    return true;
}

function createSoftwareClientAuth({ db, now = () => Date.now() } = {}) {
    if (!db || typeof db.run !== 'function') {
        throw new TypeError('A sqlite3 callback-style Database is required');
    }

    async function migrate() {
        return migrateSoftwareClientSchema(db);
    }

    async function create({ name, platform, scopes = [SOFTWARE_CLIENT_SCOPE], packageName = '' } = {}) {
        const normalizedName = normalizeText(name, 'name', 100);
        const normalizedPlatform = normalizePlatform(platform);
        const normalizedScopes = normalizeScopes(scopes);
        const normalizedPackageName = normalizePackageName(packageName);
        const createdAt = normalizeEpochSeconds(now);

        for (let attempt = 0; attempt < 5; attempt += 1) {
            const keyId = crypto.randomBytes(12).toString('base64url');
            const secret = crypto.randomBytes(32).toString('base64url');
            const rawKey = `${SOFTWARE_CLIENT_KEY_PREFIX}_${keyId}_${secret}`;
            const keyHash = hashSoftwareClientKey(rawKey).toString('hex');
            try {
                await runAsync(
                    db,
                    `INSERT INTO software_clients
                     (key_id, key_hash, name, platform, scopes, package_name, created_at, last_used_at, revoked_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
                    [
                        keyId,
                        keyHash,
                        normalizedName,
                        normalizedPlatform,
                        JSON.stringify(normalizedScopes),
                        normalizedPackageName,
                        createdAt
                    ]
                );
                return Object.freeze({
                    rawKey,
                    client: rowToClient({
                        key_id: keyId,
                        name: normalizedName,
                        platform: normalizedPlatform,
                        scopes: JSON.stringify(normalizedScopes),
                        package_name: normalizedPackageName,
                        created_at: createdAt,
                        last_used_at: null,
                        revoked_at: null
                    })
                });
            } catch (error) {
                if (!String(error?.code || '').startsWith('SQLITE_CONSTRAINT')) throw error;
            }
        }
        throw new Error('software_client_key_generation_collision');
    }

    async function validate(rawKey) {
        const parsed = parseSoftwareClientKey(rawKey);
        if (!parsed) return null;
        const row = await getAsync(
            db,
            `SELECT key_id, key_hash, name, platform, scopes, package_name,
                    created_at, last_used_at, revoked_at
             FROM software_clients WHERE key_id = ?`,
            [parsed.keyId]
        );
        const candidateHash = hashSoftwareClientKey(parsed.rawKey);
        const storedHash = row && SOFTWARE_CLIENT_HASH_PATTERN.test(String(row.key_hash || ''))
            ? Buffer.from(row.key_hash, 'hex')
            : DUMMY_KEY_HASH;
        const hashMatches = crypto.timingSafeEqual(candidateHash, storedHash);
        if (!row || !hashMatches || row.revoked_at !== null && row.revoked_at !== undefined) return null;

        const validated = rowToClient(row);
        if (!validated) return null;
        const lastUsedAt = normalizeEpochSeconds(now);
        const touched = await runAsync(
            db,
            'UPDATE software_clients SET last_used_at = ? WHERE key_id = ? AND revoked_at IS NULL',
            [lastUsedAt, parsed.keyId]
        );
        if (touched.changes !== 1) return null;
        return Object.freeze({ ...validated, lastUsedAt });
    }

    async function list() {
        const rows = await allAsync(
            db,
            `SELECT key_id, name, platform, scopes, package_name,
                    created_at, last_used_at, revoked_at
             FROM software_clients ORDER BY created_at DESC, key_id ASC`
        );
        return rows.map(rowToClient).filter(Boolean);
    }

    async function revoke(keyId) {
        const normalizedKeyId = normalizeKeyId(keyId);
        const revokedAt = normalizeEpochSeconds(now);
        const result = await runAsync(
            db,
            'UPDATE software_clients SET revoked_at = COALESCE(revoked_at, ?) WHERE key_id = ?',
            [revokedAt, normalizedKeyId]
        );
        if (result.changes !== 1) return null;
        const row = await getAsync(
            db,
            `SELECT key_id, name, platform, scopes, package_name,
                    created_at, last_used_at, revoked_at
             FROM software_clients WHERE key_id = ?`,
            [normalizedKeyId]
        );
        return rowToClient(row);
    }

    return Object.freeze({ create, list, migrate, revoke, validate });
}

module.exports = {
    SOFTWARE_CLIENT_KEY_PREFIX,
    SOFTWARE_CLIENT_SCOPE,
    createSoftwareClientAuth,
    hashSoftwareClientKey,
    migrateSoftwareClientSchema,
    parseSoftwareClientKey
};
