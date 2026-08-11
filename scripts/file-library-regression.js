'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');

const quotaStart = server.indexOf('const FILE_LIBRARY_QUOTA_BYTES');
const quotaEnd = server.indexOf('\n\nasync function resolveUserFileStorageQuota', quotaStart);
assert.ok(quotaStart >= 0 && quotaEnd > quotaStart, 'missing file library quota contract');
const quotaDeclaration = server.slice(quotaStart, quotaEnd)
    .replace('const FILE_LIBRARY_QUOTA_BYTES =', '')
    .trim()
    .replace(/;$/, '');
const quotas = vm.runInNewContext(quotaDeclaration);
assert.equal(quotas.free, 100 * 1024 * 1024);
assert.equal(quotas.pro, 200 * 1024 * 1024);
assert.equal(quotas.max, 800 * 1024 * 1024);

assert.match(server, /async function resolveUserFileStorageQuota[\s\S]*getUserMembershipSnapshot\(userId\)/);
assert.match(server, /async function recordUploadedFileWithinQuota[\s\S]*resolveUserFileStorageQuota\(userId, settings\)/);
assert.match(server, /SELECT COALESCE\(SUM\(size\), 0\) FROM file_uploads[\s\S]*\+ \? <= \?/);

assert.match(server, /app\.get\('\/api\/files', authenticateToken, apiLimiter/);
assert.match(server, /FROM file_uploads[\s\S]*WHERE user_id = \? AND upload_kind = 'attachment'/);
assert.match(server, /filePath: `\/api\/uploads\/\$\{encodeURIComponent\(row\.filename\)\}`/);
assert.match(server, /storage:[\s\S]*tier: storageQuota\.tier[\s\S]*usedBytes: stats\.totalSize[\s\S]*limitBytes: storageQuota\.limitBytes/);
assert.match(server, /app\.delete\('\/api\/files\/:filename', authenticateToken, apiLimiter/);
assert.match(server, /DELETE FROM file_uploads[\s\S]*filename = \? AND user_id = \? AND upload_kind = 'attachment'/);
assert.match(server, /app\.get\('\/api\/uploads\/:filename\/preview', authenticateToken, apiLimiter/);

assert.match(index, /id="fileLibraryEntry"[\s\S]*openFileLibrary\(\)/);
assert.match(index, /id="fileLibraryPage"[\s\S]*id="fileLibraryGrid"/);
assert.match(index, /id="fileLibraryStorageBar"/);
assert.match(app, /function openFileLibrary\(\)/);
assert.match(app, /async function loadFileLibrary[\s\S]*Authorization: `Bearer \$\{appState\.token\}`/);
assert.match(app, /function createFileLibraryItem[\s\S]*hydratePrivateAttachmentImage\(img, file\)/);
assert.match(app, /function useFileLibraryItemInChat[\s\S]*currentAttachment =/);
assert.match(app, /async function deleteFileLibraryItem[\s\S]*method: 'DELETE'/);
assert.match(app, /async function processUploadedFile\(file, options = \{\}\)[\s\S]*attachToComposer/);
assert.match(app, /media-icon">\$\{getSvgIcon\(fileLibraryIconName\(att\)/);
assert.match(styles, /\.file-library-page[\s\S]*\.file-library-grid[\s\S]*\.file-library-item/);
assert.match(styles, /@media \(max-width: 768px\)[\s\S]*\.file-library-shell/);

console.log('file-library-regression ok');
