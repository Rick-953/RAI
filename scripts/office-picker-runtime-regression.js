'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { resolveDocumentSandboxEnabled } = require('../lib/document-sandbox-runtime');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');

// Beta can advertise Office only after all production sandbox checks pass.
assert.equal(resolveDocumentSandboxEnabled({
    parserEnabled: true,
    isProduction: true,
    sandboxAvailable: true
}), true);
// Formal stays closed when its explicit production flag is not enabled.
assert.equal(resolveDocumentSandboxEnabled({
    parserEnabled: false,
    isProduction: true,
    sandboxAvailable: true
}), false);
assert.equal(resolveDocumentSandboxEnabled({
    parserEnabled: true,
    isProduction: true,
    sandboxAvailable: false
}), false);
assert.equal(resolveDocumentSandboxEnabled({
    parserEnabled: true,
    isProduction: false,
    sandboxAvailable: true
}), false);

assert.match(server, /documentSandboxEnabled:\s*DOCUMENT_SANDBOX_RUNTIME_ENABLED/);
assert.match(server, /resolveDocumentSandboxEnabled\(\{[\s\S]{0,240}parserEnabled:\s*DOCUMENT_PARSER_ENABLED[\s\S]{0,240}isProduction:\s*IS_PRODUCTION[\s\S]{0,240}sandboxAvailable:\s*isProductionDocumentSandboxAvailable\(\)/);
for (const executable of ['/usr/bin/prlimit', "path.resolve(__dirname, 'scripts', 'rai-document-parser-sandbox.sh')", '/usr/bin/bwrap', '/bin/sh']) {
    assert.ok(server.includes(executable), `runtime availability must require ${executable}`);
}
assert.match(server, /SANDBOXED_OFFICE_ATTACHMENT_EXTENSIONS = new Set\(\['docx', 'xlsx', 'pptx'\]\)/);
assert.match(server, /SANDBOXED_ARCHIVE_ATTACHMENT_EXTENSIONS = new Set\(\['zip', '7z', 'tar', 'gz', 'bz2', 'xz'\]\)/);
assert.match(server, /BLOCKED_DOCUMENT_ATTACHMENT_EXTENSIONS = new Set\(\['pdf', 'doc', 'xls', 'ppt'\]\)/);
assert.match(server, /SANDBOXED_OFFICE_ATTACHMENT_EXTENSIONS\.has\(ext\) && !DOCUMENT_SANDBOX_RUNTIME_ENABLED/);
assert.match(server, /SANDBOXED_ARCHIVE_ATTACHMENT_EXTENSIONS\.has\(ext\) && !DOCUMENT_SANDBOX_RUNTIME_ENABLED/);
for (const extension of ['zip', '7z', 'tar', 'gz', 'bz2', 'xz']) {
    assert.ok(server.includes(`ext === '${extension}'`) || server.includes(`'${extension}'`), `server must validate ${extension}`);
}

assert.match(app, /const DOCUMENT_SANDBOX_ENABLED = RAI_RUNTIME_CONFIG\.documentSandboxEnabled === true/);
assert.match(app, /office: \['docx', 'xlsx', 'pptx'\]/);
assert.match(app, /archive: \['zip', '7z', 'tar', 'gz', 'bz2', 'xz'\]/);
assert.match(app, /if \(UI_SANDBOX_UPLOAD_EXTENSIONS\.has\(extension\)\) return DOCUMENT_SANDBOX_ENABLED/);
assert.match(app, /extensions\.push\(\.\.\.UI_OFFICE_UPLOAD_EXTENSIONS, \.\.\.UI_ARCHIVE_UPLOAD_EXTENSIONS\)/);
assert.match(app, /input\.accept = getUiUploadPickerAccept\(\)/);
for (const [mimeType, extension] of [
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
    ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx'],
    ['application/zip', 'zip'],
    ['application/x-7z-compressed', '7z'],
    ['application/x-tar', 'tar'],
    ['application/gzip', 'gz'],
    ['application/x-bzip2', 'bz2'],
    ['application/x-xz', 'xz']
]) {
    assert.ok(app.includes(`'${mimeType}': '${extension}'`), `clipboard MIME must preserve .${extension}`);
}
assert.match(app, /if \(originalName && isUiAllowedUploadFile\(file\)\) return file/);

const processUploadStart = app.indexOf('async function processUploadedFile(file, options = {})');
const processUploadSource = app.slice(processUploadStart, processUploadStart + 6200);
assert.ok(processUploadStart >= 0, 'missing processUploadedFile');
assert.match(processUploadSource, /if \(!isUiAllowedUploadFile\(file\)\)/);
assert.ok(
    processUploadSource.indexOf('!isUiAllowedUploadFile(file)') < processUploadSource.indexOf('createUploadSession(file, context)'),
    'processUploadedFile must reject before upload'
);
assert.match(app, /function uploadFileWithProgress[\s\S]*xhr\.open\('POST', `\$\{API_BASE\}\/upload`\)/);

const dragDropStart = app.indexOf("function initDragAndDrop()");
const dragDropSource = app.slice(dragDropStart, dragDropStart + 2600);
assert.ok(dragDropStart >= 0, 'missing initDragAndDrop');
assert.match(dragDropSource, /processUploadedFile\(files\[0\]\)/);

console.log('office-picker-runtime-regression ok (beta enabled, formal disabled, picker/drop/process gated)');
