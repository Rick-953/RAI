'use strict';

/**
 * Short-lived, command-free file workspace.
 *
 * This module deliberately knows nothing about users, sessions, or the
 * database. The server adapter resolves an owned upload and passes a bounded
 * source descriptor. The workspace records the resulting owner/session in a
 * manifest so download authorization remains fail-closed after a restart.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_ROOT = '/run/rai-file-jobs';
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 1000;
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_READ_BYTES = 512 * 1024;
const MAX_ARTIFACT_BYTES = 512 * 1024;
const MAX_SANDBOX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 32 * 1024;
const MAX_ACTIVE_TASKS = 64;
const MAX_OWNER_ACTIVE_TASKS = 8;
const MAX_WORKSPACE_BYTES = 40 * 1024 * 1024;
const TASK_ID_RE = /^[a-f0-9]{48}$/;
const ARTIFACT_ID_RE = /^[a-f0-9]{32}$/;
const FILE_ID_RE = /^[0-9]{10,17}-[a-f0-9]{12}\.[a-z0-9]{1,10}$/i;
const TASK_LOCK_GRACE_MS = 5 * 60 * 1000;

const READ_MODES = new Set(['metadata', 'text', 'markdown']);
const TRANSFORM_OPERATIONS = new Set([
    'extract_markdown',
    'csv_to_markdown',
    'json_pretty',
    'text_to_markdown'
]);
const ARTIFACT_FORMATS = new Set(['text', 'markdown', 'json', 'csv']);
const FORMAT_EXTENSIONS = Object.freeze({
    text: 'txt',
    markdown: 'md',
    json: 'json',
    csv: 'csv'
});
const FORMAT_MIME_TYPES = Object.freeze({
    text: 'text/plain; charset=utf-8',
    markdown: 'text/markdown; charset=utf-8',
    json: 'application/json; charset=utf-8',
    csv: 'text/csv; charset=utf-8'
});

class FileWorkspaceError extends Error {
    constructor(code, message = code, statusCode = 400) {
        super(message);
        this.name = 'FileWorkspaceError';
        this.code = code;
        this.statusCode = statusCode;
    }
}

function boundedInteger(value, fallback, min, max) {
    const number = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, number));
}

function randomHex(bytes) {
    return crypto.randomBytes(bytes).toString('hex');
}

function normalizeOwner(value, field) {
    const normalized = String(value ?? '').trim();
    if (!normalized || normalized.length > 160 || /[\u0000-\u001f\u007f]/.test(normalized)) {
        throw new FileWorkspaceError(`workspace_${field}_invalid`);
    }
    return normalized;
}

function normalizeUserId(value) {
    const numeric = Number(value);
    if (!Number.isSafeInteger(numeric) || numeric <= 0) {
        throw new FileWorkspaceError('workspace_user_invalid', 'workspace_user_invalid', 401);
    }
    return String(numeric);
}

function normalizeTaskId(value) {
    const id = String(value || '').trim();
    if (!TASK_ID_RE.test(id)) throw new FileWorkspaceError('workspace_task_invalid', 'workspace_task_invalid', 404);
    return id;
}

function normalizeArtifactId(value) {
    const id = String(value || '').trim();
    if (!ARTIFACT_ID_RE.test(id)) throw new FileWorkspaceError('workspace_artifact_invalid', 'workspace_artifact_invalid', 404);
    return id;
}

function normalizeFileId(value) {
    const id = path.basename(String(value || '').trim());
    if (!FILE_ID_RE.test(id) || id !== String(value || '').trim()) {
        throw new FileWorkspaceError('workspace_source_invalid', 'workspace_source_invalid', 400);
    }
    return id;
}

function normalizeDisplayName(value, fallback) {
    const raw = String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/[\\/]/g, '_').trim();
    const safe = raw.slice(0, 128);
    return safe || fallback;
}

function assertInsideRoot(rootDir, candidate) {
    const root = path.resolve(rootDir);
    const resolved = path.resolve(candidate);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
        throw new FileWorkspaceError('workspace_path_blocked', 'workspace_path_blocked', 403);
    }
    return resolved;
}

async function lstatRegularNoFollow(filePath, errorCode = 'workspace_source_unavailable') {
    let stat;
    try {
        stat = await fs.promises.lstat(filePath);
    } catch (_) {
        throw new FileWorkspaceError(errorCode, errorCode, 404);
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new FileWorkspaceError(errorCode, errorCode, 404);
    }
    return stat;
}

async function readRegularFile(filePath, maxBytes, errorCode = 'workspace_source_unavailable') {
    const stat = await lstatRegularNoFollow(filePath, errorCode);
    if (stat.size > maxBytes) {
        throw new FileWorkspaceError('workspace_file_too_large', 'workspace_file_too_large', 413);
    }
    const flags = fs.constants.O_RDONLY | Number(fs.constants.O_NOFOLLOW || 0);
    let handle;
    try {
        handle = await fs.promises.open(filePath, flags);
        const current = await handle.stat();
        if (!current.isFile() || current.isSymbolicLink() || current.size > maxBytes) {
            throw new FileWorkspaceError('workspace_source_unavailable', 'workspace_source_unavailable', 404);
        }
        const buffer = Buffer.alloc(current.size);
        let offset = 0;
        while (offset < buffer.length) {
            const result = await handle.read(buffer, offset, buffer.length - offset, offset);
            if (!result.bytesRead) break;
            offset += result.bytesRead;
        }
        return buffer.subarray(0, offset);
    } catch (error) {
        if (error instanceof FileWorkspaceError) throw error;
        throw new FileWorkspaceError(errorCode, errorCode, 404);
    } finally {
        if (handle) await handle.close().catch(() => null);
    }
}

function decodeUtf8(buffer) {
    try {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        return decoder.decode(buffer);
    } catch (_) {
        throw new FileWorkspaceError('workspace_text_encoding_invalid', 'workspace_text_encoding_invalid', 422);
    }
}

function assertTextPayload(text, code = 'workspace_text_invalid') {
    if (text.includes('\u0000')) throw new FileWorkspaceError(code, code, 422);
    return text;
}

function textToMarkdown(name, source) {
    const heading = normalizeDisplayName(name, '文件');
    const indented = String(source || '').split('\n').map((line) => `    ${line}`).join('\n');
    return `# ${heading}\n\n${indented}`.slice(0, MAX_ARTIFACT_BYTES);
}

function normalizeOperation(value) {
    const operation = String(value || '').trim().toLowerCase();
    if (!TRANSFORM_OPERATIONS.has(operation)) {
        throw new FileWorkspaceError('workspace_operation_blocked', 'workspace_operation_blocked', 400);
    }
    return operation;
}

function normalizeFormat(value) {
    const format = String(value || '').trim().toLowerCase();
    if (!ARTIFACT_FORMATS.has(format)) {
        throw new FileWorkspaceError('workspace_format_blocked', 'workspace_format_blocked', 400);
    }
    return format;
}

class FileWorkspace {
    constructor(options = {}) {
        this.rootDir = path.resolve(String(options.rootDir || DEFAULT_ROOT));
        this.ttlMs = boundedInteger(options.ttlMs, DEFAULT_TTL_MS, 60 * 1000, 60 * 60 * 1000);
        this.cleanupIntervalMs = boundedInteger(options.cleanupIntervalMs, DEFAULT_CLEANUP_INTERVAL_MS, 10 * 1000, 60 * 60 * 1000);
        this.maxActiveTasks = boundedInteger(options.maxActiveTasks, MAX_ACTIVE_TASKS, 1, MAX_ACTIVE_TASKS);
        this.maxOwnerActiveTasks = boundedInteger(options.maxOwnerActiveTasks, MAX_OWNER_ACTIVE_TASKS, 1, MAX_OWNER_ACTIVE_TASKS);
        this.maxWorkspaceBytes = boundedInteger(
            options.maxWorkspaceBytes,
            MAX_WORKSPACE_BYTES,
            MAX_ARTIFACT_BYTES + MAX_MANIFEST_BYTES + 4096,
            MAX_WORKSPACE_BYTES
        );
        this.now = typeof options.now === 'function' ? options.now : () => Date.now();
        this.parseDocumentFile = typeof options.parseDocumentFile === 'function' ? options.parseDocumentFile : null;
        this.cleanupTimer = null;
        this.creationTail = Promise.resolve();
    }

    async init() {
        await fs.promises.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
        await fs.promises.chmod(this.rootDir, 0o700).catch(() => null);
        await this.cleanupExpired();
        return this;
    }

    startCleanup() {
        if (this.cleanupTimer) return;
        this.cleanupTimer = setInterval(() => {
            this.cleanupExpired().catch(() => null);
        }, this.cleanupIntervalMs);
        this.cleanupTimer.unref?.();
    }

    stopCleanup() {
        if (!this.cleanupTimer) return;
        clearInterval(this.cleanupTimer);
        this.cleanupTimer = null;
    }

    _owner(userId, sessionId) {
        return {
            userId: normalizeUserId(userId),
            sessionId: normalizeOwner(sessionId, 'session')
        };
    }

    _taskPath(taskId) {
        return assertInsideRoot(this.rootDir, path.join(this.rootDir, normalizeTaskId(taskId)));
    }

    _artifactPath(taskId, artifactId) {
        const taskPath = this._taskPath(taskId);
        const id = normalizeArtifactId(artifactId);
        return assertInsideRoot(taskPath, path.join(taskPath, `artifact-${id}`));
    }

    async _measureWorkspaceUsage(owner) {
        const usage = { taskCount: 0, ownerTaskCount: 0, bytes: 0 };
        let entries;
        try { entries = await fs.promises.readdir(this.rootDir, { withFileTypes: true }); } catch (_) { return usage; }
        for (const entry of entries) {
            if (!entry.isDirectory() || entry.isSymbolicLink() || !TASK_ID_RE.test(entry.name)) continue;
            const taskPath = assertInsideRoot(this.rootDir, path.join(this.rootDir, entry.name));
            let manifest;
            try { ({ manifest } = await this._readManifest(entry.name)); } catch (_) { continue; }
            usage.taskCount += 1;
            if (manifest.userId === owner.userId) usage.ownerTaskCount += 1;
            usage.bytes += await this._measureDirectoryBytes(taskPath);
        }
        return usage;
    }

    async _measureDirectoryBytes(directoryPath) {
        let bytes = 0;
        const pending = [directoryPath];
        let visited = 0;
        while (pending.length > 0 && visited < 2048) {
            const current = pending.pop();
            let entries = [];
            try { entries = await fs.promises.readdir(current, { withFileTypes: true }); } catch (_) { continue; }
            for (const entry of entries) {
                if (entry.isSymbolicLink()) continue;
                const candidate = assertInsideRoot(directoryPath, path.join(current, entry.name));
                visited += 1;
                if (entry.isDirectory()) {
                    pending.push(candidate);
                } else if (entry.isFile()) {
                    try { bytes += (await fs.promises.lstat(candidate)).size; } catch (_) {}
                }
                if (visited >= 2048) break;
            }
        }
        return bytes;
    }

    async _createTaskUnlocked(owner, operation) {
        await this.cleanupExpired();
        const usage = await this._measureWorkspaceUsage(owner);
        if (usage.ownerTaskCount >= this.maxOwnerActiveTasks) {
            throw new FileWorkspaceError('workspace_owner_task_limit', 'workspace_owner_task_limit', 429);
        }
        if (usage.taskCount >= this.maxActiveTasks) {
            throw new FileWorkspaceError('workspace_task_capacity_exceeded', 'workspace_task_capacity_exceeded', 503);
        }
        const reservedBytes = MAX_ARTIFACT_BYTES + MAX_MANIFEST_BYTES + 4096;
        if (usage.bytes + reservedBytes > this.maxWorkspaceBytes) {
            throw new FileWorkspaceError('workspace_storage_capacity_exceeded', 'workspace_storage_capacity_exceeded', 503);
        }
        const taskId = randomHex(24);
        const taskPath = this._taskPath(taskId);
        try {
            await fs.promises.mkdir(taskPath, { mode: 0o700 });
        } catch (error) {
            if (error.code === 'EEXIST') return this._createTask(owner, operation);
            throw error;
        }
        const createdAt = this.now();
        const manifest = {
            version: 1,
            taskId,
            userId: owner.userId,
            sessionId: owner.sessionId,
            operation,
            createdAt,
            expiresAt: createdAt + this.ttlMs,
            artifacts: []
        };
        await this._writeManifest(taskPath, manifest);
        return { taskId, taskPath, manifest };
    }

    async _createTask(owner, operation) {
        const run = this.creationTail
            .catch(() => undefined)
            .then(() => this._createTaskUnlocked(owner, operation));
        this.creationTail = run.catch(() => undefined);
        return run;
    }

    async _writeManifest(taskPath, manifest) {
        const manifestPath = assertInsideRoot(taskPath, path.join(taskPath, 'manifest.json'));
        const payload = JSON.stringify(manifest);
        if (Buffer.byteLength(payload, 'utf8') > MAX_MANIFEST_BYTES) {
            throw new FileWorkspaceError('workspace_manifest_too_large', 'workspace_manifest_too_large', 500);
        }
        const tempPath = `${manifestPath}.${randomHex(8)}.tmp`;
        try {
            await fs.promises.writeFile(tempPath, payload, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
            await fs.promises.rename(tempPath, manifestPath);
        } finally {
            await fs.promises.unlink(tempPath).catch(() => null);
        }
    }

    async _readManifest(taskId) {
        const taskPath = this._taskPath(taskId);
        let taskStat;
        try { taskStat = await fs.promises.lstat(taskPath); } catch (_) {
            throw new FileWorkspaceError('workspace_task_missing', 'workspace_task_missing', 404);
        }
        if (!taskStat.isDirectory() || taskStat.isSymbolicLink()) {
            throw new FileWorkspaceError('workspace_task_missing', 'workspace_task_missing', 404);
        }
        const manifestPath = assertInsideRoot(taskPath, path.join(taskPath, 'manifest.json'));
        const raw = await readRegularFile(manifestPath, MAX_MANIFEST_BYTES, 'workspace_task_missing');
        let manifest;
        try { manifest = JSON.parse(raw.toString('utf8')); } catch (_) {
            throw new FileWorkspaceError('workspace_task_invalid', 'workspace_task_invalid', 404);
        }
        if (
            !manifest || manifest.version !== 1
            || manifest.taskId !== taskId
            || typeof manifest.userId !== 'string'
            || typeof manifest.sessionId !== 'string'
            || !Number.isFinite(Number(manifest.expiresAt))
            || !Array.isArray(manifest.artifacts)
        ) {
            throw new FileWorkspaceError('workspace_task_invalid', 'workspace_task_invalid', 404);
        }
        return { taskPath, manifest };
    }

    async _writeArtifact(task, format, content, displayName) {
        const bytes = Buffer.from(String(content || ''), 'utf8');
        if (bytes.length > MAX_ARTIFACT_BYTES) {
            throw new FileWorkspaceError('workspace_artifact_too_large', 'workspace_artifact_too_large', 413);
        }
        const artifactId = randomHex(16);
        const filePath = this._artifactPath(task.taskId, artifactId);
        await fs.promises.writeFile(filePath, bytes, { mode: 0o600, flag: 'wx' });
        const extension = FORMAT_EXTENSIONS[format];
        const artifact = {
            artifactId,
            fileName: normalizeDisplayName(displayName, `artifact.${extension}`),
            storageName: `artifact-${artifactId}`,
            format,
            mimeType: FORMAT_MIME_TYPES[format],
            size: bytes.length
        };
        task.manifest.artifacts.push(artifact);
        await this._writeManifest(task.taskPath, task.manifest);
        return {
            taskId: task.taskId,
            artifactId,
            fileName: artifact.fileName,
            mimeType: artifact.mimeType,
            size: artifact.size,
            expiresAt: task.manifest.expiresAt,
            downloadPath: `/api/file-jobs/${task.taskId}/artifacts/${artifactId}?sessionId=${encodeURIComponent(task.manifest.sessionId)}`
        };
    }

    async readFile({ userId, sessionId, source, mode = 'text' }) {
        const owner = this._owner(userId, sessionId);
        const normalizedMode = String(mode || 'text').trim().toLowerCase();
        if (!READ_MODES.has(normalizedMode)) {
            throw new FileWorkspaceError('workspace_read_mode_blocked', 'workspace_read_mode_blocked', 400);
        }
        const descriptor = this._validateSourceDescriptor(source, owner);
        const filePath = descriptor.path;
        const stat = await lstatRegularNoFollow(filePath);
        const metadata = {
            fileName: descriptor.fileName,
            mimeType: descriptor.mimeType,
            size: stat.size,
            extension: path.extname(descriptor.fileName).toLowerCase().slice(1)
        };
        if (normalizedMode === 'metadata') return { metadata };
        const text = await this._extractSourceText(descriptor, normalizedMode === 'markdown');
        return { metadata, text: text.slice(0, MAX_READ_BYTES) };
    }

    async transformFile({ userId, sessionId, source, operation, fileName = '' }) {
        const owner = this._owner(userId, sessionId);
        const normalizedOperation = normalizeOperation(operation);
        const descriptor = this._validateSourceDescriptor(source, owner);
        const text = await this._extractSourceText(descriptor, true);
        let output;
        let format = 'markdown';
        let displayName = fileName;
        if (normalizedOperation === 'json_pretty') {
            if (path.extname(descriptor.fileName).toLowerCase() !== '.json') {
                throw new FileWorkspaceError('workspace_operation_input_blocked', 'workspace_operation_input_blocked', 422);
            }
            let parsed;
            try { parsed = JSON.parse(text); } catch (_) {
                throw new FileWorkspaceError('workspace_json_invalid', 'workspace_json_invalid', 422);
            }
            output = JSON.stringify(parsed, null, 2);
            format = 'json';
            displayName = displayName || 'transformed.json';
        } else if (normalizedOperation === 'csv_to_markdown') {
            if (path.extname(descriptor.fileName).toLowerCase() !== '.csv') {
                throw new FileWorkspaceError('workspace_operation_input_blocked', 'workspace_operation_input_blocked', 422);
            }
            // CSV is parsed into bounded Markdown by the document sandbox.
            // Never parse that Markdown again in this trusted workspace.
            output = text;
            displayName = displayName || 'transformed.md';
        } else if (normalizedOperation === 'text_to_markdown') {
            if (!descriptor.isText) {
                throw new FileWorkspaceError('workspace_operation_input_blocked', 'workspace_operation_input_blocked', 422);
            }
            output = textToMarkdown(descriptor.fileName, text);
            displayName = displayName || 'transformed.md';
        } else {
            if (!descriptor.isOffice && path.extname(descriptor.fileName).toLowerCase() !== '.csv') {
                throw new FileWorkspaceError('workspace_operation_input_blocked', 'workspace_operation_input_blocked', 422);
            }
            output = text;
            displayName = displayName || 'extracted.md';
        }
        const task = await this._createTask(owner, normalizedOperation);
        try {
            return await this._writeArtifact(task, format, output, displayName);
        } catch (error) {
            await this._removeTask(task.taskPath);
            throw error;
        }
    }

    async createArtifact({ userId, sessionId, format, content, fileName = '' }) {
        const owner = this._owner(userId, sessionId);
        const normalizedFormat = normalizeFormat(format);
        if (typeof content !== 'string' || !content.trim()) {
            throw new FileWorkspaceError('workspace_artifact_content_invalid', 'workspace_artifact_content_invalid', 422);
        }
        const boundedContent = assertTextPayload(content.slice(0, MAX_ARTIFACT_BYTES), 'workspace_artifact_content_invalid');
        if (normalizedFormat === 'json') {
            try { JSON.parse(boundedContent); } catch (_) {
                throw new FileWorkspaceError('workspace_json_invalid', 'workspace_json_invalid', 422);
            }
        }
        const task = await this._createTask(owner, 'create_artifact');
        try {
            const defaultName = `artifact.${FORMAT_EXTENSIONS[normalizedFormat]}`;
            return await this._writeArtifact(task, normalizedFormat, boundedContent, fileName || defaultName);
        } catch (error) {
            await this._removeTask(task.taskPath);
            throw error;
        }
    }

    async createSandboxTask({ userId, sessionId }) {
        const owner = this._owner(userId, sessionId);
        return await this._createTask(owner, 'sandbox_exec');
    }

    async writeSandboxArtifact({ task, sourcePath, fileName = '', mimeType = 'application/octet-stream' }) {
        if (!task?.taskId || !task?.taskPath || !task?.manifest) {
            throw new FileWorkspaceError('workspace_task_invalid', 'workspace_task_invalid', 400);
        }
        const resolvedSource = assertInsideRoot(task.taskPath, sourcePath);
        const stat = await lstatRegularNoFollow(resolvedSource, 'workspace_artifact_missing');
        if (stat.size > MAX_SANDBOX_ARTIFACT_BYTES) {
            throw new FileWorkspaceError('workspace_artifact_too_large', 'workspace_artifact_too_large', 413);
        }
        const usage = await this._measureWorkspaceUsage({ userId: task.manifest.userId });
        if (usage.bytes + stat.size > this.maxWorkspaceBytes) {
            throw new FileWorkspaceError('workspace_storage_capacity_exceeded', 'workspace_storage_capacity_exceeded', 503);
        }
        const artifactId = randomHex(16);
        const destination = this._artifactPath(task.taskId, artifactId);
        await fs.promises.copyFile(resolvedSource, destination, fs.constants.COPYFILE_EXCL);
        await fs.promises.chmod(destination, 0o600).catch(() => null);
        const artifact = {
            artifactId,
            fileName: normalizeDisplayName(fileName || path.basename(resolvedSource), 'artifact.bin'),
            storageName: `artifact-${artifactId}`,
            format: 'binary',
            mimeType: String(mimeType || 'application/octet-stream').slice(0, 120),
            size: stat.size
        };
        task.manifest.artifacts.push(artifact);
        await this._writeManifest(task.taskPath, task.manifest);
        return {
            taskId: task.taskId,
            artifactId,
            fileName: artifact.fileName,
            mimeType: artifact.mimeType,
            size: artifact.size,
            expiresAt: task.manifest.expiresAt,
            downloadPath: `/api/file-jobs/${task.taskId}/artifacts/${artifactId}?sessionId=${encodeURIComponent(task.manifest.sessionId)}`
        };
    }

    async discardSandboxTask(task) {
        if (!task?.taskPath) return;
        await this._removeTask(task.taskPath);
    }

    _validateSourceDescriptor(source = {}, owner = null) {
        if (!source || typeof source !== 'object') {
            throw new FileWorkspaceError('workspace_source_invalid', 'workspace_source_invalid', 400);
        }
        const rootDir = path.resolve(String(source.rootDir || ''));
        const storageName = normalizeFileId(source.storageName || source.fileId);
        const rootBase = path.basename(rootDir);
        if (!rootDir || !['uploads'].includes(rootBase)) {
            throw new FileWorkspaceError('workspace_source_invalid', 'workspace_source_invalid', 400);
        }
        if (source.ownerUserId !== undefined && String(source.ownerUserId) !== owner?.userId) {
            throw new FileWorkspaceError('workspace_source_forbidden', 'workspace_source_forbidden', 404);
        }
        if (source.ownerSessionId !== undefined && String(source.ownerSessionId) !== owner?.sessionId) {
            throw new FileWorkspaceError('workspace_source_forbidden', 'workspace_source_forbidden', 404);
        }
        const filePath = assertInsideRoot(rootDir, path.join(rootDir, storageName));
        const fileName = normalizeDisplayName(source.fileName || storageName, storageName);
        const extension = path.extname(fileName).toLowerCase().slice(1);
        const isOffice = ['docx', 'xlsx', 'pptx'].includes(extension);
        const isText = ['txt', 'md', 'json', 'xml', 'csv', 'log', 'yaml', 'yml', 'ini', 'conf', 'html', 'htm', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'css', 'scss', 'less', 'vue', 'svelte', 'swift', 'kt', 'go', 'rs', 'sh', 'bash', 'zsh', 'sql', 'php', 'pl', 'rb'].includes(extension);
        return {
            path: filePath,
            fileName,
            mimeType: String(source.mimeType || '').slice(0, 120),
            extension,
            isOffice,
            isText
        };
    }

    async _extractSourceText(descriptor, markdownMode) {
        if (descriptor.isOffice || descriptor.extension === 'csv') {
            if (!this.parseDocumentFile) throw new FileWorkspaceError('workspace_parser_unavailable', 'workspace_parser_unavailable', 503);
            const kind = descriptor.extension;
            const parsed = await this.parseDocumentFile(descriptor.path, kind);
            const text = assertTextPayload(String(parsed?.text || ''), 'workspace_parser_output_invalid');
            return text;
        }
        if (!descriptor.isText) {
            throw new FileWorkspaceError('workspace_read_mode_blocked', 'workspace_read_mode_blocked', 422);
        }
        const buffer = await readRegularFile(descriptor.path, Math.min(MAX_SOURCE_BYTES, MAX_READ_BYTES), 'workspace_source_unavailable');
        const text = assertTextPayload(decodeUtf8(buffer));
        return markdownMode ? text : text;
    }

    async prepareDownload({ userId, sessionId, taskId, artifactId }) {
        const owner = this._owner(userId, sessionId);
        const { taskPath, manifest } = await this._readManifest(normalizeTaskId(taskId));
        const now = this.now();
        if (manifest.userId !== owner.userId || manifest.sessionId !== owner.sessionId) {
            throw new FileWorkspaceError('workspace_artifact_forbidden', 'workspace_artifact_forbidden', 404);
        }
        if (now >= Number(manifest.expiresAt)) {
            await this._removeTask(taskPath);
            throw new FileWorkspaceError('workspace_artifact_expired', 'workspace_artifact_expired', 410);
        }
        const artifact = manifest.artifacts.find((item) => item?.artifactId === normalizeArtifactId(artifactId));
        if (!artifact || !ARTIFACT_ID_RE.test(String(artifact.storageName || '').replace(/^artifact-/, ''))) {
            throw new FileWorkspaceError('workspace_artifact_missing', 'workspace_artifact_missing', 404);
        }
        const lockPath = assertInsideRoot(taskPath, path.join(taskPath, '.download.lock'));
        let lockHandle;
        try {
            lockHandle = await fs.promises.open(lockPath, 'wx', 0o600);
            await lockHandle.writeFile(JSON.stringify({ startedAt: now }));
        } catch (_) {
            throw new FileWorkspaceError('workspace_artifact_consumed', 'workspace_artifact_consumed', 410);
        } finally {
            if (lockHandle) await lockHandle.close().catch(() => null);
        }
        const filePath = assertInsideRoot(taskPath, path.join(taskPath, artifact.storageName));
        try {
            const stat = await lstatRegularNoFollow(filePath, 'workspace_artifact_missing');
            return {
                filePath,
                fileName: normalizeDisplayName(artifact.fileName, 'artifact.bin'),
                mimeType: String(artifact.mimeType || 'application/octet-stream').slice(0, 120),
                size: stat.size,
                expiresAt: manifest.expiresAt,
                finalize: async () => this._removeTask(taskPath)
            };
        } catch (error) {
            await this._removeTask(taskPath);
            throw error;
        }
    }

    async _removeTask(taskPath) {
        const resolved = assertInsideRoot(this.rootDir, taskPath);
        const base = path.basename(resolved);
        if (!TASK_ID_RE.test(base)) return;
        let stat;
        try { stat = await fs.promises.lstat(resolved); } catch (_) { return; }
        if (!stat.isDirectory() || stat.isSymbolicLink()) return;
        await fs.promises.rm(resolved, { recursive: true, force: true, maxRetries: 1, retryDelay: 10 });
    }

    async cleanupExpired() {
        let entries;
        try { entries = await fs.promises.readdir(this.rootDir, { withFileTypes: true }); } catch (_) { return 0; }
        const now = this.now();
        let removed = 0;
        for (const entry of entries) {
            if (!entry.isDirectory() || entry.isSymbolicLink() || !TASK_ID_RE.test(entry.name)) continue;
            const taskPath = assertInsideRoot(this.rootDir, path.join(this.rootDir, entry.name));
            let manifest;
            try {
                ({ manifest } = await this._readManifest(entry.name));
            } catch (_) {
                await this._removeTask(taskPath);
                removed += 1;
                continue;
            }
            let lockStat = null;
            try { lockStat = await fs.promises.lstat(path.join(taskPath, '.download.lock')); } catch (_) {}
            const lockFresh = lockStat && (now - lockStat.mtimeMs) < TASK_LOCK_GRACE_MS;
            if (Number(manifest.expiresAt) <= now && !lockFresh) {
                await this._removeTask(taskPath);
                removed += 1;
            }
        }
        return removed;
    }
}

module.exports = {
    ARTIFACT_FORMATS,
    DEFAULT_ROOT,
    DEFAULT_TTL_MS,
    FileWorkspace,
    FileWorkspaceError,
    MAX_ARTIFACT_BYTES,
    MAX_SANDBOX_ARTIFACT_BYTES,
    MAX_ACTIVE_TASKS,
    MAX_READ_BYTES,
    MAX_OWNER_ACTIVE_TASKS,
    MAX_SOURCE_BYTES,
    MAX_WORKSPACE_BYTES,
    READ_MODES,
    TASK_ID_RE,
    ARTIFACT_ID_RE,
    TRANSFORM_OPERATIONS,
    normalizeFormat,
    normalizeOperation
};
