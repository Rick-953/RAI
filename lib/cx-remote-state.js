'use strict';
// Only durable device-key hashes and scoped consent metadata belong here. Never
// serialize access tokens, local paths, tool arguments/results, or live jobs.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const MAX_BYTES = 2 * 1024 * 1024;
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;
const owner = value => Number.isSafeInteger(value) && value > 0;
const keysOnly = (value, names) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => names.includes(key));
function validate(state) {
    if (!keysOnly(state, ['schema', 'devices', 'grants']) || state.schema !== 'rai.cx-remote-consent.v1' || !Array.isArray(state.devices) || !Array.isArray(state.grants)
        || state.devices.length > 256 || state.grants.length > 2048) throw Error('cx_remote_state_invalid');
    const deviceIds = new Set(), grantIds = new Set();
    for (const d of state.devices) {
        if (!keysOnly(d, ['id', 'userId', 'secretHash', 'installationHash', 'authorizationProtocol', 'name', 'version']) || !/^cx_[A-Za-z0-9_-]{20,100}$/.test(d.id) || deviceIds.has(d.id) || !owner(d.userId)
            || !hex(d.secretHash) || !hex(d.installationHash) || d.authorizationProtocol !== 'web-v2'
            || !text(d.name, 80) || typeof d.version !== 'string' || d.version.length > 30) throw Error('cx_remote_state_invalid');
        deviceIds.add(d.id);
    }
    for (const g of state.grants) {
        const d = state.devices.find(d => d.id === g.deviceId);
        if (!keysOnly(g, ['id', 'userId', 'authSessionId', 'deviceId', 'conversationId', 'rootId', 'createdAt']) || !/^cxg_[A-Za-z0-9_-]{20,100}$/.test(g.id) || grantIds.has(g.id) || !d || d.userId !== g.userId
            || !text(g.authSessionId, 200) || !text(g.conversationId, 200) || !hex(g.rootId)
            || !Number.isFinite(g.createdAt) || g.createdAt < 0) throw Error('cx_remote_state_invalid');
        grantIds.add(g.id);
    }
    return state;
}
function createCxRemoteStateStore(statePath) {
    const empty = () => ({ schema: 'rai.cx-remote-consent.v1', devices: [], grants: [] });
    return {
        load() {
            if (!statePath) return empty();
            let fd;
            try {
                // Check and read the same open object, never reopen a checked path.
                // Linux rejects symlinks atomically and avoids blocking on a FIFO.
                const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
                try { fd = fs.openSync(statePath, flags); }
                catch (error) {
                    if (error.code !== 'ENOENT') throw Error('cx_remote_state_invalid');
                    // A dangling Windows symlink must not be treated as empty state.
                    try { fs.lstatSync(statePath); } catch (missing) { if (missing.code === 'ENOENT') return empty(); throw missing; }
                    throw Error('cx_remote_state_invalid');
                }
                const info = fs.fstatSync(fd, { bigint: true });
                if (!info.isFile() || info.size > BigInt(MAX_BYTES) || (process.platform !== 'win32' && (info.mode & 0o077n) !== 0n)) throw Error('cx_remote_state_invalid');
                if (process.platform === 'win32') {
                    // Windows has no O_NOFOLLOW: reject links and require the path
                    // identity to agree with the already-open handle before reading.
                    const entry = fs.lstatSync(statePath, { bigint: true });
                    if (entry.isSymbolicLink() || entry.dev !== info.dev || entry.ino !== info.ino) throw Error('cx_remote_state_invalid');
                }
                const content = Buffer.alloc(MAX_BYTES + 1);
                let length = 0, count;
                do { count = fs.readSync(fd, content, length, content.length - length, length); length += count; }
                while (count > 0 && length < content.length);
                if (length > MAX_BYTES) throw Error('cx_remote_state_invalid');
                return validate(JSON.parse(content.subarray(0, length).toString('utf8')));
            } finally { if (fd !== undefined) fs.closeSync(fd); }
        },
        save(value) {
            validate(value);
            if (!statePath) return; // Explicit in-memory fixtures; production supplies a private path.
            const content = JSON.stringify(value);
            if (Buffer.byteLength(content) > MAX_BYTES) throw Error('cx_remote_state_too_large');
            const directory = path.dirname(statePath);
            fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
            const temp = statePath + '.' + crypto.randomBytes(12).toString('hex') + '.tmp';
            let fd;
            try {
                fd = fs.openSync(temp, 'wx', 0o600);
                fs.writeFileSync(fd, content, 'utf8'); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
                fs.renameSync(temp, statePath);
                // Persist the rename on production Linux. Windows does not expose directory fsync.
                if (process.platform !== 'win32') {
                    fd = fs.openSync(directory, 'r'); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
                }
            } finally {
                if (fd !== undefined) fs.closeSync(fd);
                try { fs.unlinkSync(temp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
            }
        }
    };
}
module.exports = { createCxRemoteStateStore };