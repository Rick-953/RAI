'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const cache = fs.readFileSync(path.join(root, 'public', 'conversation-cache.js'), 'utf8');
const parser = fs.readFileSync(path.join(root, 'lib', 'document-parser.js'), 'utf8');

assert.match(
    server,
    /function buildStoredMessageAttachments[\s\S]*originalName:[\s\S]*mimeType:[\s\S]*size:[\s\S]*fileId[\s\S]*filePath/
);
assert.match(
    server,
    /function extractMessageAttachmentRefs[\s\S]*fileName:[\s\S]*size:[\s\S]*filePath:/
);
assert.match(
    server,
    /function hydrateMessageAttachmentRefs[\s\S]*user_id = \?[\s\S]*original_name = \?[\s\S]*30\.0 \/ 1440\.0/
);
assert.match(server, /\['image', 'audio', 'video', 'file', 'document', 'text', 'code'\]/);
assert.match(server, /attachment_parse_temporarily_unavailable/);
assert.match(server, /makePrivateEtag\(`\$\{PACKAGE_VERSION\}:\$\{req\.user\.userId\}:\$\{req\.params\.id\}:/);
assert.match(server, /attachmentOriginalContentByMessage\.set\(lastMsg, lastMsg\.content\)/);
assert.match(server, /const latestAttachmentMessage = \[\.\.\.messages\]\.reverse\(\)\.find/);
assert.match(server, /const activeAttachments = Array\.isArray\(lastMsg\?\.attachments\)[\s\S]*latestAttachmentMessage\?\.attachments/);
assert.match(server, /workspaceAttachmentCatalog = messages[\s\S]*\.flatMap\(\(message\) => \(Array\.isArray\(message\?\.attachments\)/);
assert.match(server, /workspaceAttachmentCatalog\.length > 0[\s\S]*internetMode = false[\s\S]*normalizedResearchMode = 'off'/);
assert.match(server, /读取、修改、解压或重新压缩时必须直接使用其 file_id/);
assert.match(server, /function getPersistableUserMessageContent/);
assert.match(server, /stripInjectedAttachmentPromptContext\(message\.content\)/);

assert.match(app, /message\.attachments \|\| message\.attachment_refs/);
assert.match(app, /let attachments = m\.attachments \|\| m\.attachment_refs/);
assert.match(app, /Number\(att\.size\) > 0 \? formatFileSize/);
assert.match(app, /async function fetchPrivateAttachmentBlob[\s\S]*Authorization: `Bearer \$\{appState\.token\}`/);
assert.match(app, /async function previewAttachment[\s\S]*fetch\(`\$\{url\}\/preview`/);
assert.match(app, /async function downloadAttachment[\s\S]*a\.download = att\.fileName/);
assert.match(app, /attachment-preview-btn[\s\S]*attachment-download-btn/);
assert.match(app, /function addGeneratedImageActions[\s\S]*generated-image-preview[\s\S]*generated-image-download/);
assert.match(app, /async function fetchPrivateGeneratedImageBlob[\s\S]*Authorization: `Bearer \$\{context\.token\}`/);
assert.match(app, /async function previewGeneratedImage[\s\S]*showPrivateFilePreview/);
assert.match(app, /async function downloadGeneratedImage[\s\S]*link\.download = generatedImageFileName/);
assert.match(app, /const safeLocalThumbnail = rawLocalThumbnail\.startsWith\('blob:'\)[\s\S]*safeLocalThumbnail === rawLocalThumbnail/);
assert.doesNotMatch(app, /点击加载附件|Click to load attachments|loadMessageAttachments|lazy-attachment-placeholder/);
assert.match(server, /app\.get\('\/api\/uploads\/:filename\/preview', apiLimiter, authenticateToken/);
assert.match(server, /WHERE filename = \? AND user_id = \? AND upload_kind = 'attachment'/);
assert.match(server, /SANDBOXED_OFFICE_ATTACHMENT_EXTENSIONS\.has\(ext\)[\s\S]*parseDocumentFile\(filePath, ext\)/);
assert.match(server, /Cache-Control', 'private, no-store'/);
assert.match(cache, /MESSAGE_FORMAT_VERSION = 3/);
assert.match(cache, /formatVersion: MESSAGE_FORMAT_VERSION/);
assert.match(cache, /Number\(row\.formatVersion \|\| 0\) !== MESSAGE_FORMAT_VERSION/);

assert.match(parser, /DEFAULT_TRANSIENT_RETRIES = 1/);
assert.match(parser, /TRANSIENT_PARSER_ERRORS[\s\S]*document_parser_response_invalid/);
assert.match(parser, /executeParserJobWithRetry\(job\.filePath, job\.kind, job\.options\)/);

console.log('attachment-autoload-regression ok');
