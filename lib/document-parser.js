'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const WORKER_PATH = path.resolve(__dirname, '..', 'workers', 'document-parser-worker.js');
const SANDBOX_LAUNCHER_PATH = path.resolve(__dirname, '..', 'scripts', 'rai-document-parser-sandbox.sh');
const PRODUCTION_NODE_ROOT = '/opt/rai/runtime/node-v24.16.0';
const PRODUCTION_APP_ROOTS = Object.freeze({
    formal: '/opt/rai/apps/formal',
    beta: '/opt/rai/apps/beta'
});
const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_STDOUT_BYTES = 512 * 1024;
const MAX_STDERR_BYTES = 32 * 1024;
const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_CONCURRENCY = 1;
const DEFAULT_QUEUE_LIMIT = 4;
const DEFAULT_TRANSIENT_RETRIES = 1;
const ALLOWED_KINDS = new Set(['docx', 'xlsx', 'pptx', 'csv']);
const TRANSIENT_PARSER_ERRORS = new Set([
    'document_parser_response_invalid',
    'document_parser_spawn_failed'
]);

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

function normalizeProductionProfile(value) {
    const profile = String(value || 'formal').trim().toLowerCase();
    return Object.hasOwn(PRODUCTION_APP_ROOTS, profile) ? profile : '';
}

function isProductionDocumentSandboxAvailable(profileValue = process.env.RAI_DOCUMENT_PARSER_PROFILE) {
    const profile = normalizeProductionProfile(profileValue);
    if (!profile || process.platform !== 'linux') return false;
    const appRoot = PRODUCTION_APP_ROOTS[profile];
    try {
        for (const executable of [
            '/usr/bin/prlimit',
            '/usr/bin/bwrap',
            '/bin/sh',
            SANDBOX_LAUNCHER_PATH,
            path.join(PRODUCTION_NODE_ROOT, 'bin', 'node')
        ]) {
            fs.accessSync(executable, fs.constants.X_OK);
        }
        for (const readablePath of [
            path.join(appRoot, 'workers', 'document-parser-worker.js'),
            path.join(appRoot, 'node_modules'),
            '/lib',
            '/lib64'
        ]) {
            fs.accessSync(readablePath, fs.constants.R_OK);
        }
        return true;
    } catch (_) {
        return false;
    }
}

function productionSandboxCommand(kind) {
    const profile = normalizeProductionProfile(process.env.RAI_DOCUMENT_PARSER_PROFILE);
    if (!profile) throw createParserError('document_parser_profile_invalid', 503);
    if (!isProductionDocumentSandboxAvailable(profile)) {
        throw createParserError('document_parser_sandbox_unavailable', 503);
    }
    return {
        command: SANDBOX_LAUNCHER_PATH,
        args: [profile, kind]
    };
}

function localWorkerCommand(kind) {
    const maxOldSpaceMb = boundedInteger(process.env.RAI_DOCUMENT_PARSER_MEMORY_MB, 160, 96, 160);
    return {
        command: process.execPath,
        args: [`--max-old-space-size=${maxOldSpaceMb}`, WORKER_PATH, kind]
    };
}

function resolveWorkerCommand(kind) {
    if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') {
        return productionSandboxCommand(kind);
    }
    return localWorkerCommand(kind);
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
            const workerCommand = resolveWorkerCommand(kind);
            child = spawn(workerCommand.command, workerCommand.args, {
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
            child.once('error', (error) => finish(createParserError(error?.code === 'ENOENT' ? 'document_parser_sandbox_unavailable' : 'document_parser_spawn_failed', 503)));
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

async function executeParserJobWithRetry(filePath, kind, options = {}) {
    const retries = boundedInteger(
        options.transientRetries,
        DEFAULT_TRANSIENT_RETRIES,
        0,
        DEFAULT_TRANSIENT_RETRIES
    );
    let attempt = 0;
    while (true) {
        try {
            return await executeParserJob(filePath, kind, options);
        } catch (error) {
            if (attempt >= retries || !TRANSIENT_PARSER_ERRORS.has(String(error?.code || ''))) {
                throw error;
            }
            attempt += 1;
        }
    }
}

function pumpQueue() {
    const concurrency = String(process.env.NODE_ENV || '').toLowerCase() === 'production'
        ? DEFAULT_CONCURRENCY
        : boundedInteger(process.env.RAI_DOCUMENT_PARSER_CONCURRENCY, DEFAULT_CONCURRENCY, 1, DEFAULT_CONCURRENCY);
    while (activeJobs < concurrency && pendingJobs.length > 0) {
        const job = pendingJobs.shift();
        activeJobs += 1;
        executeParserJobWithRetry(job.filePath, job.kind, job.options)
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
    const queueLimit = String(process.env.NODE_ENV || '').toLowerCase() === 'production'
        ? DEFAULT_QUEUE_LIMIT
        : boundedInteger(process.env.RAI_DOCUMENT_PARSER_QUEUE_LIMIT, DEFAULT_QUEUE_LIMIT, 1, DEFAULT_QUEUE_LIMIT);
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
    ALLOWED_KINDS,
    isProductionDocumentSandboxAvailable
};
