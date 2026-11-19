'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { extractNamedFunction } = require('./beta-static-security-contracts');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8').replace(/\r\n/g, '\n');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');

const quotaStart = server.indexOf('const FILE_LIBRARY_QUOTA_BYTES');
const quotaEnd = server.indexOf('\n});', quotaStart) + '\n});'.length;
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

assert.match(server, /app\.get\('\/api\/files', apiLimiter, authenticateToken/);
assert.match(server, /FROM file_uploads[\s\S]*WHERE user_id = \? AND upload_kind = 'attachment'/);
assert.match(server, /filePath: `\/api\/uploads\/\$\{encodeURIComponent\(row\.filename\)\}`/);
assert.match(server, /storage:[\s\S]*tier: storageQuota\.tier[\s\S]*usedBytes: stats\.totalSize[\s\S]*limitBytes: storageQuota\.limitBytes/);
assert.match(server, /app\.delete\('\/api\/files\/:filename', apiLimiter, authenticateToken/);
assert.match(server, /DELETE FROM file_uploads[\s\S]*filename = \? AND user_id = \? AND upload_kind = 'attachment'/);
assert.match(server, /app\.get\('\/api\/uploads\/:filename\/preview', apiLimiter, authenticateToken/);

assert.match(index, /id="fileLibraryEntry"[\s\S]*openFileLibrary\(\)/);
assert.match(index, /id="fileLibraryPage"[\s\S]*id="fileLibraryGrid"/);
assert.match(index, /id="fileLibraryStorageBar"/);
assert.match(app, /function openFileLibrary\(\)/);
assert.match(app, /async function loadFileLibrary[\s\S]*Authorization: `Bearer \$\{appState\.token\}`/);
assert.match(app, /function createFileLibraryItem[\s\S]*hydratePrivateAttachmentImage\(img, file\)/);
assert.match(app, /function useFileLibraryItemInChat[\s\S]*currentAttachments\.push\(/);
assert.match(app, /async function deleteFileLibraryItem[\s\S]*method: 'DELETE'/);
assert.match(app, /async function processUploadedFile\(file, options = \{\}\)[\s\S]*attachToComposer/);
assert.match(app, /media-icon">\$\{getSvgIcon\(fileLibraryIconName\(att\)/);
assert.match(styles, /\.file-library-page[\s\S]*\.file-library-grid[\s\S]*\.file-library-item/);
assert.match(styles, /\.file-library-entry:focus-visible/);
assert.match(styles, /prefers-reduced-motion: reduce/);
assert.match(styles, /padding: calc\(var\(--header-height\) \+ 22px\) 16px calc\(24px \+ env\(safe-area-inset-bottom/);
assert.match(styles, /@media \(max-width: 768px\)[\s\S]*\.file-library-shell/);

for (const [page, api, root] of [
    ['https://rai.test/', '/api', 'https://rai.test'],
    ['https://rai.test/beta/', '/beta/api', 'https://rai.test/beta'],
    ['http://tauri.localhost/', 'https://rai.test/api', 'https://rai.test']
]) {
    const context = vm.createContext({ URL, window: { location: new URL(page) }, API_BASE: api, RAI_IS_TAURI_DESKTOP: page.includes('tauri.localhost') });
    const functions = ['resolvePrivateMediaUrl', 'resolvePrivateGeneratedImageUrl', 'resolveAttachmentUrl', 'resolveProtectedFileJobUrl'];
    vm.runInContext(functions.map(name => extractNamedFunction(app, name)).join('\n'), context);
    const upload = '/api/uploads/1763000000000-abcdef123456.png';
    const generated = '/generated-images/generated-1763000000000-abcdef123456-1.png';
    for (const filePath of [upload, root + upload]) {
        assert.equal(new URL(context.resolveAttachmentUrl({ filePath }), page).href, root + upload);
    }
    for (const value of [generated, root + generated]) assert.equal(context.resolvePrivateGeneratedImageUrl(value), root + generated);
    assert.equal(context.resolveAttachmentUrl({ filePath: 'https://other.test' + upload }), '', 'private attachments must belong to the configured API');
    assert.equal(context.resolveAttachmentUrl({ filePath: '/api/health' }), '', 'a non-file route is not an attachment');
    const artifact = `/api/file-jobs/${'1'.repeat(48)}/artifacts/${'2'.repeat(32)}?sessionId=chat`;
    assert.equal(new URL(context.resolveAttachmentUrl({ filePath: artifact }), page).href, root + artifact);
}

console.log('file-library-regression ok');
