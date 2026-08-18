'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { auditSandboxScript } = require('./sandbox-command-policy');

const MAX_SCRIPT_BYTES = 32 * 1024;
const MAX_INPUT_FILES = 8;
const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_WORK_BYTES = 24 * 1024 * 1024;
const MAX_WORK_FILES = 512;
const MAX_CAPTURE_BYTES = 64 * 1024;
const WALL_TIMEOUT_MS = 20 * 1000;
const GLOBAL_CONCURRENCY = 2;
const OWNER_CONCURRENCY = 1;

const MIME_BY_EXTENSION = Object.freeze({
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.py': 'text/x-python; charset=utf-8',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.zip': 'application/zip',
    '.7z': 'application/x-7z-compressed',
    '.tar': 'application/x-tar',
    '.gz': 'application/gzip',
    '.bz2': 'application/x-bzip2',
    '.xz': 'application/x-xz',
    '.pdf': 'application/pdf'
});

class LinuxSandboxError extends Error {
    constructor(code, statusCode = 400) {
        super(code);
        this.name = 'LinuxSandboxError';
        this.code = code;
        this.statusCode = statusCode;
    }
}

function boundedScript(value) {
    const script = String(value || '');
    const bytes = Buffer.byteLength(script, 'utf8');
    if (!script.trim() || bytes > MAX_SCRIPT_BYTES || script.includes('\u0000')) {
        throw new LinuxSandboxError('sandbox_script_invalid', 422);
    }
    return script;
}

function safeFileName(value, fallback = 'input.bin') {
    const cleaned = path.basename(String(value || ''))
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .replace(/[^a-zA-Z0-9._()\-\u4e00-\u9fff ]/g, '_')
        .replace(/^\.+/, '')
        .trim()
        .slice(0, 120);
    return cleaned || fallback;
}

function normalizeOutputPath(value) {
    const output = String(value || '').trim().replace(/\\/g, '/');
    if (!output) return '';
    if (output.startsWith('/') || output.includes('\u0000')) {
        throw new LinuxSandboxError('sandbox_output_path_invalid', 422);
    }
    const segments = output.split('/');
    if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
        throw new LinuxSandboxError('sandbox_output_path_invalid', 422);
    }
    return output.slice(0, 240);
}

function appendBounded(chunks, chunk, state) {
    if (state.bytes >= MAX_CAPTURE_BYTES) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = MAX_CAPTURE_BYTES - state.bytes;
    chunks.push(buffer.subarray(0, remaining));
    state.bytes += Math.min(buffer.length, remaining);
    if (buffer.length > remaining) state.truncated = true;
}

async function inspectTree(rootDir) {
    const pending = [rootDir];
    let bytes = 0;
    let files = 0;
    while (pending.length > 0) {
        const current = pending.pop();
        let entries = [];
        try { entries = await fs.promises.readdir(current, { withFileTypes: true }); } catch (_) { continue; }
        for (const entry of entries) {
            if (entry.isSymbolicLink()) continue;
            const candidate = path.join(current, entry.name);
            if (entry.isDirectory()) {
                pending.push(candidate);
            } else if (entry.isFile()) {
                files += 1;
                try { bytes += (await fs.promises.lstat(candidate)).size; } catch (_) {}
            }
            if (bytes > MAX_WORK_BYTES || files > MAX_WORK_FILES) return { bytes, files, exceeded: true };
        }
    }
    return { bytes, files, exceeded: false };
}

async function findImplicitOutputCandidate(rootDir, inputNames = new Set()) {
    const pending = [rootDir];
    const candidates = [];
    while (pending.length > 0) {
        const current = pending.pop();
        const entries = await fs.promises.readdir(current, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            if (entry.isSymbolicLink()) continue;
            const candidate = path.join(current, entry.name);
            if (entry.isDirectory()) {
                pending.push(candidate);
                continue;
            }
            if (!entry.isFile()) continue;
            const relative = path.relative(rootDir, candidate).replace(/\\/g, '/');
            if (!relative || inputNames.has(relative) || !MIME_BY_EXTENSION[path.extname(entry.name).toLowerCase()]) continue;
            const stat = await fs.promises.lstat(candidate).catch(() => null);
            if (stat?.isFile() && !stat.isSymbolicLink() && stat.size > 0) candidates.push(candidate);
        }
    }
    return candidates.length === 1 ? candidates[0] : null;
}

function buildSandboxArgs(workspaceDir) {
    const bwrapArgs = [
        '--unshare-all',
        '--die-with-parent',
        '--new-session',
        '--clearenv',
        '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin',
        '--setenv', 'HOME', '/workspace',
        '--setenv', 'NODE_OPTIONS', '--max-old-space-size=128',
        '--setenv', 'LANG', 'C.UTF-8',
        '--setenv', 'LC_ALL', 'C.UTF-8',
        '--setenv', 'TZ', 'UTC',
        '--ro-bind', '/usr', '/usr',
        '--ro-bind', '/bin', '/bin',
        '--ro-bind', '/lib', '/lib',
        '--ro-bind', '/lib64', '/lib64',
        '--bind', workspaceDir, '/workspace',
        '--dir', '/proc',
        '--dev', '/dev',
        '--tmpfs', '/tmp',
        '--chdir', '/workspace',
        '--uid', '65534',
        '--gid', '65534',
        '--cap-drop', 'ALL',
        '--', '/bin/sh', '-s'
    ];
    return [
        '--as=2147483648',
        '--cpu=15',
        '--nproc=96',
        '--nofile=64',
        '--fsize=16777216',
        '--data=268435456',
        '--stack=8388608',
        '--core=0',
        '--',
        '/usr/bin/nice', '-n', '10',
        '/usr/bin/bwrap',
        ...bwrapArgs
    ];
}

class LinuxSandbox {
    constructor({ fileWorkspace }) {
        if (!fileWorkspace) throw new Error('linux_sandbox_file_workspace_required');
        this.fileWorkspace = fileWorkspace;
        this.active = 0;
        this.ownerActive = new Map();
    }

    _acquire(userId) {
        const owner = String(userId || '');
        const ownerCount = this.ownerActive.get(owner) || 0;
        if (this.active >= GLOBAL_CONCURRENCY) throw new LinuxSandboxError('sandbox_capacity_exceeded', 503);
        if (ownerCount >= OWNER_CONCURRENCY) throw new LinuxSandboxError('sandbox_owner_busy', 429);
        this.active += 1;
        this.ownerActive.set(owner, ownerCount + 1);
        return () => {
            this.active = Math.max(0, this.active - 1);
            const next = Math.max(0, (this.ownerActive.get(owner) || 1) - 1);
            if (next) this.ownerActive.set(owner, next);
            else this.ownerActive.delete(owner);
        };
    }

    async run({ userId, sessionId, sources = [], script, outputPath = '', artifactFileName = '' }) {
        const normalizedScript = boundedScript(script);
        // Hard command policy runs BEFORE any process is spawned. Blocked
        // scripts are rejected with readable reasons; nothing is executed.
        const audit = auditSandboxScript(normalizedScript);
        if (!audit.allowed) {
            const reasons = audit.blocked.map((entry) => `${entry.id}: ${entry.reason}`).join('; ');
            throw new LinuxSandboxError(`sandbox_command_blocked::${reasons}`, 422);
        }
        const normalizedOutput = normalizeOutputPath(outputPath);
        if (!Array.isArray(sources) || sources.length > MAX_INPUT_FILES) {
            throw new LinuxSandboxError('sandbox_input_limit', 413);
        }
        const release = this._acquire(userId);
        let task;
        let keepTask = false;
        try {
            task = await this.fileWorkspace.createSandboxTask({ userId, sessionId });
            keepTask = true;
            const workspaceDir = path.join(task.taskPath, 'workspace');
            await fs.promises.mkdir(workspaceDir, { mode: 0o700, recursive: true });
            const inputFiles = [];
            const usedNames = new Set();
            let inputBytes = 0;
            for (let index = 0; index < sources.length; index += 1) {
                const source = sources[index];
                const stat = await fs.promises.lstat(source.path);
                if (!stat.isFile() || stat.isSymbolicLink()) throw new LinuxSandboxError('sandbox_input_invalid', 422);
                inputBytes += stat.size;
                if (inputBytes > MAX_INPUT_BYTES) throw new LinuxSandboxError('sandbox_input_limit', 413);
                let name = safeFileName(source.fileName, `input-${index + 1}.bin`);
                if (usedNames.has(name)) name = `${index + 1}-${name}`;
                usedNames.add(name);
                const destination = path.join(workspaceDir, name);
                const destinationExists = await fs.promises.lstat(destination).catch(() => null);
                if (destinationExists) {
                    name = `${Date.now()}-${name}`;
                }
                const uniqueDestination = path.join(workspaceDir, name);
                await fs.promises.copyFile(source.path, uniqueDestination, fs.constants.COPYFILE_EXCL);
                await fs.promises.chmod(uniqueDestination, 0o600);
                inputFiles.push({ file_id: source.fileId, path: `/workspace/${name}`, size: stat.size });
            }

            const execution = await this._spawn(workspaceDir, normalizedScript);
            let artifact = null;
            let implicitOutput = false;
            if (execution.exitCode === 0 && !execution.limitExceeded) {
                const implicitCandidate = normalizedOutput
                    ? null
                    : await findImplicitOutputCandidate(workspaceDir, new Set(inputFiles.map((item) => item.path.replace('/workspace/', ''))));
                const candidate = normalizedOutput
                    ? path.resolve(workspaceDir, normalizedOutput)
                    : implicitCandidate;
                if (candidate) {
                const rootPrefix = `${path.resolve(workspaceDir)}${path.sep}`;
                if (!candidate.startsWith(rootPrefix)) throw new LinuxSandboxError('sandbox_output_path_invalid', 422);
                const stat = await fs.promises.lstat(candidate).catch(() => null);
                if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
                    throw new LinuxSandboxError('sandbox_output_missing', 422);
                }
                artifact = await this.fileWorkspace.writeSandboxArtifact({
                    task,
                    sourcePath: candidate,
                    fileName: safeFileName(artifactFileName || path.basename(candidate), path.basename(candidate)),
                    mimeType: MIME_BY_EXTENSION[path.extname(candidate).toLowerCase()] || 'application/octet-stream'
                });
                keepTask = true;
                implicitOutput = !normalizedOutput;
                }
            }
            // The per-user workspace is retained until its three-hour TTL; artifact
            // publishing copies the requested output into the same owned task.
            return {
                ok: execution.exitCode === 0 && !execution.limitExceeded,
                exit_code: execution.exitCode,
                timed_out: execution.timedOut,
                limit_exceeded: execution.limitExceeded,
                stdout: execution.stdout,
                stderr: execution.stderr,
                output_truncated: execution.outputTruncated,
                inputs: inputFiles,
                auto_output: implicitOutput,
                ...(artifact || {})
            };
        } finally {
            if (task && !keepTask) await this.fileWorkspace.discardSandboxTask(task).catch(() => null);
            release();
        }
    }

    async _spawn(workspaceDir, script) {
        return await new Promise((resolve, reject) => {
            const child = spawn('/usr/bin/prlimit', buildSandboxArgs(workspaceDir), {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }
            });
            const stdout = [];
            const stderr = [];
            const stdoutState = { bytes: 0, truncated: false };
            const stderrState = { bytes: 0, truncated: false };
            let settled = false;
            let timedOut = false;
            let limitExceeded = false;
            let monitorBusy = false;
            const stopChild = () => {
                child.kill('SIGKILL');
                setTimeout(() => child.kill('SIGKILL'), 100).unref?.();
            };
            const timeout = setTimeout(() => {
                timedOut = true;
                stopChild();
            }, WALL_TIMEOUT_MS);
            timeout.unref?.();
            const monitor = setInterval(async () => {
                if (monitorBusy || settled) return;
                monitorBusy = true;
                try {
                    const usage = await inspectTree(workspaceDir);
                    if (usage.exceeded) {
                        limitExceeded = true;
                        stopChild();
                    }
                } finally {
                    monitorBusy = false;
                }
            }, 50);
            monitor.unref?.();

            child.stdout.on('data', (chunk) => appendBounded(stdout, chunk, stdoutState));
            child.stderr.on('data', (chunk) => appendBounded(stderr, chunk, stderrState));
            child.once('error', (error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                clearInterval(monitor);
                reject(new LinuxSandboxError(error?.code === 'ENOENT' ? 'sandbox_runtime_unavailable' : 'sandbox_spawn_failed', 503));
            });
            child.once('close', (code, signal) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                clearInterval(monitor);
                resolve({
                    exitCode: Number.isInteger(code) ? code : (signal ? 137 : 1),
                    timedOut,
                    limitExceeded,
                    stdout: Buffer.concat(stdout).toString('utf8'),
                    stderr: Buffer.concat(stderr).toString('utf8'),
                    outputTruncated: stdoutState.truncated || stderrState.truncated
                });
            });
            child.stdin.once('error', () => null);
            child.stdin.end(script);
        });
    }
}

module.exports = Object.freeze({
    GLOBAL_CONCURRENCY,
    LinuxSandbox,
    LinuxSandboxError,
    MAX_CAPTURE_BYTES,
    MAX_INPUT_BYTES,
    MAX_INPUT_FILES,
    MAX_SCRIPT_BYTES,
    MAX_WORK_BYTES,
    MAX_WORK_FILES,
    OWNER_CONCURRENCY,
    WALL_TIMEOUT_MS,
    findImplicitOutputCandidate,
    normalizeOutputPath
});
