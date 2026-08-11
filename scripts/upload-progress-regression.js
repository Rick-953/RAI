'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');
const docs = fs.readFileSync(path.join(root, 'docs', 'UPLOAD-API.md'), 'utf8');

assert.match(server, /const UPLOAD_PROGRESS_TTL_MS = 30 \* 60 \* 1000/);
assert.match(server, /const UPLOAD_PROGRESS_MAX_SESSIONS = 10000/);
assert.match(server, /const uploadProgressSessions = new Map\(\)/);
assert.match(server, /uploadProgressSessions\.size >= UPLOAD_PROGRESS_MAX_SESSIONS\) return null/);
assert.match(server, /code: 'upload_sessions_busy'/);
assert.match(server, /app\.post\('\/api\/uploads\/sessions', apiLimiter, authenticateToken/);
assert.match(server, /app\.get\('\/api\/uploads\/:uploadId\/status', apiLimiter, authenticateToken/);
assert.match(server, /Number\(session\.userId\) !== Number\(req\.user\.userId\)/);
assert.match(server, /res\.setHeader\('Cache-Control', 'private, no-store'\)/);
assert.match(server, /function startUploadByteTracking[\s\S]*req\.on\('data'/);
assert.match(server, /middleware\(req, res,[\s\S]*startUploadByteTracking\(req\)/);
assert.match(server, /req\.once\('aborted',[\s\S]*upload_aborted/);
assert.match(server, /status: 'processing'/);
assert.match(server, /status: 'completed'[\s\S]*uploadId: req\.uploadProgressSession\.id/);
assert.match(server, /status: 'failed'/);
assert.match(server, /X-RAI-Upload-ID/);

assert.match(app, /async function createUploadSession[\s\S]*\/uploads\/sessions/);
assert.match(app, /function uploadFileWithProgress[\s\S]*new XMLHttpRequest\(\)/);
assert.match(app, /xhr\.upload\.addEventListener\('progress'/);
assert.match(app, /xhr\.upload\.addEventListener\('load'/);
assert.match(app, /xhr\.setRequestHeader\('X-RAI-Upload-ID', session\.uploadId\)/);
assert.match(app, /data\.status !== 'completed'/);
assert.match(app, /role="progressbar"[\s\S]*aria-valuenow="0"/);
assert.match(app, /function renderUploadProgress[\s\S]*uploadProgressGeneration/);
assert.match(styles, /\.upload-progress[\s\S]*\.upload-progress-track[\s\S]*\.upload-progress-bar/);

assert.match(docs, /POST \/api\/uploads\/sessions/);
assert.match(docs, /GET \/api\/uploads\/:uploadId\/status/);
assert.match(docs, /pending.*uploading.*processing/s);
assert.match(docs, /completed.*failed/s);

console.log('upload-progress-regression ok');
