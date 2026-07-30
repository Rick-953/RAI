'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const WORKER_PATH = path.resolve(__dirname, '..', 'workers', 'document-parser-worker.js');
const NODE_MODULES_PATH = path.resolve(__dirname, '..', 'node_modules');
const PACKAGE_JSON_PATH = path.resolve(__dirname, '..', 'package.json');
const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const MAX_STDOUT_BYTES = 512 * 1024;
const MAX_STDERR_BYTES = 32 * 1024;
const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_QUEUE_LIMIT = 8;
const ALLOWED_KINDS = new Set(['docx', 'xlsx', 'pptx']);

let activeJobs = 0;
const pendingJobs = [];

function boundedInteger(value, fallback, min, max) {
    const parsed = Number.parseInt(String(value || ''), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

function createParserError(code, statusCode = 422) {
    const error = new Error(code);
    error.code = code;
    error.statusCode = statusCode;
    return error;
}

function permissionArguments() {
    const nodeMajor = Number.parseInt(String(process.versions?.node || '').split('.')[0], 10) || 0;
    if (String(process.env.NODE_ENV || '').toLowerCase() === 'production' && nodeMajor < 25) {
        throw createParserError('document_parser_network_isolation_unavailable', 503);
    }
    const permissionFlag = process.allowedNodeEnvironmentFlags?.has('--permission')
        ? '--permission'
        : (process.allowedNodeEnvironmentFlags?.has('--experimental-permission')
            ? '--experimental-permission'
            : '');
    if (!permissionFlag) {
        throw createParserError('document_parser_permission_model_unavailable', 503);
    }
    const readableDependencyRoots = new Set([NODE_MODULES_PATH]);
    // Node resolves modules through the symlink path but reads source bytes
    // from its canonical target. Permission Model builds therefore need both
    // names when node_modules is a symlink (as in isolated release checks).
    try {
        readableDependencyRoots.add(fs.realpathSync(NODE_MODULES_PATH));
    } catch (_) {
        // The worker spawn will report the missing runtime dependency normally.
    }
    return [
        permissionFlag,
        `--allow-fs-read=${WORKER_PATH}`,
        ...[...readableDependencyRoots].map((root) => `--allow-fs-read=${root}`),
        `--allow-fs-read=${PACKAGE_JSON_PATH}`
    ];
}

async function openRegularDocument(filePath) {
    const resolvedPath = path.resolve(String(filePath || ''));
    const preOpen = await fs.promises.lstat(resolvedPath);
    if (!preOpen.isFile() || preOpen.isSymbolicLink()) {
        throw createParserError('document_source_not_regular');
    }
    const noFollow = Number(fs.constants.O_NOFOLLOW || 0);
    const handle = await fs.promises.open(resolvedPath, fs.constants.O_RDONLY | noFollow);
    try {
        const stats = await handle.stat();
        if (!stats.isFile()) throw createParserError('document_source_not_regular');
        if (stats.size <= 0) throw createParserError('document_input_empty');
        if (stats.size > MAX_INPUT_BYTES) throw createParserError('document_input_limit_exceeded', 413);
        return { handle, size: stats.size };
    } catch (error) {
        await handle.close().catch(() => null);
        throw error;
    }
}

function executeParserJob(filePath, kind, options = {}) {
    return new Promise(async (resolve, reject) => {
        let documentHandle;
        let child;
        let timeoutHandle;
        let settled = false;
        const cleanup = async () => {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            if (documentHandle) await documentHandle.close().catch(() => null);
        };
        const finish = async (error, value) => {
            if (settled) return;
            settled = true;
            await cleanup();
            if (error) reject(error);
            else resolve(value);
        };

        try {
            ({ handle: documentHandle } = await openRegularDocument(filePath));
            const timeoutMs = boundedInteger(options.timeoutMs || process.env.RAI_DOCUMENT_PARSER_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1000, 30000);
            const maxOldSpaceMb = boundedInteger(process.env.RAI_DOCUMENT_PARSER_MEMORY_MB, 160, 96, 256);
            const args = [
                `--max-old-space-size=${maxOldSpaceMb}`,
                ...permissionArguments(),
                WORKER_PATH,
                kind
            ];
            child = spawn(process.execPath, args, {
                cwd: path.dirname(WORKER_PATH),
                env: {
                    NODE_ENV: 'production',
                    LANG: 'C.UTF-8',
                    LC_ALL: 'C.UTF-8',
                    TZ: 'UTC'
                },
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true
            });

            const stdout = [];
            const stderr = [];
            let stdoutBytes = 0;
            let stderrBytes = 0;

            child.stdout.on('data', (chunk) => {
                stdoutBytes += chunk.length;
                if (stdoutBytes > MAX_STDOUT_BYTES) {
                    child.kill('SIGKILL');
                    finish(createParserError('document_parser_output_limit'));
                    return;
                }
                stdout.push(chunk);
            });
            child.stderr.on('data', (chunk) => {
                if (stderrBytes >= MAX_STDERR_BYTES) return;
                const remaining = MAX_STDERR_BYTES - stderrBytes;
                const value = chunk.subarray(0, remaining);
                stderrBytes += value.length;
                stderr.push(value);
            });
            child.once('error', (error) => finish(createParserError(error?.code === 'ENOENT' ? 'document_parser_runtime_missing' : 'document_parser_spawn_failed', 503)));
            child.once('close', (code, signal) => {
                if (settled) return;
                let payload;
                try {
                    payload = JSON.parse(Buffer.concat(stdout, stdoutBytes).toString('utf8'));
                } catch (_) {
                    return finish(createParserError(signal ? 'document_parser_terminated' : 'document_parser_response_invalid'));
                }
                if (code !== 0 || !payload?.ok) {
                    return finish(createParserError(String(payload?.error || 'document_parse_failed').slice(0, 160)));
                }
                return finish(null, {
                    text: String(payload.text || ''),
                    meta: payload.meta && typeof payload.meta === 'object' ? payload.meta : {}
                });
            });

            timeoutHandle = setTimeout(() => {
                child.kill('SIGKILL');
                finish(createParserError('document_parser_timeout', 408));
            }, timeoutMs);
            timeoutHandle.unref?.();

            child.stdin.on('error', (error) => {
                if (error?.code !== 'EPIPE') finish(createParserError('document_parser_input_failed'));
            });
            const input = documentHandle.createReadStream({ autoClose: false });
            input.once('error', () => finish(createParserError('document_source_read_failed')));
            input.pipe(child.stdin);
        } catch (error) {
            await finish(error?.code ? error : createParserError('document_parser_failed'));
        }
    });
}

function pumpQueue() {
    const concurrency = boundedInteger(process.env.RAI_DOCUMENT_PARSER_CONCURRENCY, DEFAULT_CONCURRENCY, 1, 4);
    while (activeJobs < concurrency && pendingJobs.length > 0) {
        const job = pendingJobs.shift();
        activeJobs += 1;
        executeParserJob(job.filePath, job.kind, job.options)
            .then(job.resolve, job.reject)
            .finally(() => {
                activeJobs -= 1;
                pumpQueue();
            });
    }
}

function parseDocumentFile(filePath, kind, options = {}) {
    const normalizedKind = String(kind || '').toLowerCase();
    if (!ALLOWED_KINDS.has(normalizedKind)) {
        return Promise.reject(createParserError('document_kind_blocked'));
    }
    const queueLimit = boundedInteger(process.env.RAI_DOCUMENT_PARSER_QUEUE_LIMIT, DEFAULT_QUEUE_LIMIT, 1, 32);
    if (pendingJobs.length >= queueLimit) {
        return Promise.reject(createParserError('document_parser_queue_full', 503));
    }
    return new Promise((resolve, reject) => {
        pendingJobs.push({ filePath, kind: normalizedKind, options, resolve, reject });
        pumpQueue();
    });
}

module.exports = {
    parseDocumentFile,
    createParserError,
    ALLOWED_KINDS
};
