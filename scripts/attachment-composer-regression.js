'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

function between(source, start, end) {
    const begin = source.indexOf(start);
    const finish = source.indexOf(end, begin);
    assert.ok(begin >= 0 && finish > begin, `missing source boundary: ${start}`);
    return source.slice(begin, finish);
}

async function serverCases() {
    const policy = vm.runInNewContext(`${between(serverSource, 'const CLIENT_FILE_INTENT_PATTERN', 'async function executeSearchWithBudget')}\nisClientFileIntent`);
    for (const type of ['image', 'file', 'text', 'document']) {
        assert.equal(policy('查看图片，分析这个文件', [{ type, fileId: 'same-image' }]), false);
        assert.equal(policy('编辑这张图片', [{ type, filePath: 'C:\\cache\\original.png' }]), false);
    }
    assert.equal(policy('创建一个 txt 文件', []), true);
    assert.equal(policy('再分析一下这张图片', [], [{ file_id: 'previous.png' }]), false);
    assert.equal(policy('你好', []), false);
    assert.equal((serverSource.match(/isClientFileIntent\(userContent, lastUserMsg\.attachments, workspaceAttachmentCatalog\)/g) || []).length, 3,
        'all three synthetic list_files fallbacks must check current attachments');
    const limit = serverSource.match(/const CHAT_CLIENT_MAX_ATTACHMENTS = [^;]+;/)[0];
    const normalizeName = between(serverSource, 'function normalizeUploadOriginalName(', 'const storage = multer.diskStorage(');
    const sanitize = vm.runInNewContext(`${limit}\n${normalizeName}\n${between(serverSource, 'function sanitizeClientAttachment(', 'function attachmentTypeFromMime(')}\nsanitizeClientAttachments`, { path, Buffer });
    const nine = Array.from({ length: 9 }, (_, index) => ({ type: index % 2 ? 'file' : 'image', fileName: `${index}.txt` }));
    assert.equal(sanitize(nine).length, 9);
    assert.throws(() => sanitize([...nine, nine[0]]), error => error.code === 'too_many_attachments');
    const convert = vm.runInNewContext(`(${between(serverSource, 'async function convertToOmniFormat(', '/**')})`, {
        buildAttachmentImageDataUrl: async () => 'data:image/png;base64,AA=='
    });
    const image = await convert({ role: 'user', content: 'Describe the image; its cache path is the same file.', attachments: [{ type: 'image', fileId: 'one.png' }] }, 1);
    assert.equal(image.content.filter(part => part.type === 'image_url').length, 1);
    assert.equal(image.content.filter(part => part.type === 'text').length, 1);
    console.log('attachment-composer: server nine-file bound and single-attachment identity passed');
}

async function browserCases() {
    const http = require('node:http');
    const { chromium, webkit } = require('playwright');
    const uploads = [];
    let failUploads = false;
    let uploadGate = null;
    const service = http.createServer(async (req, res) => {
        try {
            const pathname = new URL(req.url, 'http://localhost').pathname;
            if (pathname === '/api/uploads/sessions') {
                req.resume();
                res.setHeader('Content-Type', 'application/json');
                return res.end(JSON.stringify({ success: true, uploadId: 'upl_' + '1'.repeat(32) }));
            }
            if (pathname === '/api/upload') {
                const chunks = [];
                for await (const chunk of req) chunks.push(chunk);
                const form = await new Response(Buffer.concat(chunks), { headers: { 'Content-Type': req.headers['content-type'] } }).formData();
                const file = form.get('file');
                uploads.push({ name: file.name, bytes: Buffer.from(await file.arrayBuffer()) });
                if (uploadGate) await uploadGate;
                res.setHeader('Content-Type', 'application/json');
                if (failUploads) {
                    res.statusCode = 400;
                    return res.end(JSON.stringify({ error: 'Fixture rejected upload' }));
                }
                return res.end(JSON.stringify({ success: true, status: 'completed', file: { filename: `${uploads.length}.txt`, filePath: `/api/uploads/${uploads.length}.txt` } }));
            }
            if (pathname.startsWith('/api/')) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                return res.end('{}');
            }
            const publicRoot = path.join(root, 'public');
            const file = path.resolve(publicRoot, '.' + (pathname === '/' ? '/index.html' : pathname));
            if (!file.startsWith(publicRoot + path.sep)) { res.writeHead(404); return res.end(); }
            res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[path.extname(file)] || 'application/octet-stream');
            fs.createReadStream(file).on('error', () => { res.writeHead(404); res.end(); }).pipe(res);
        } catch (error) { res.writeHead(500); res.end(String(error)); }
    });
    await new Promise(resolve => service.listen(0, '127.0.0.1', resolve));
    const engine = process.env.RAI_BROWSER_ENGINE === 'webkit' ? webkit : chromium;
    let browser;
    try {
        browser = await engine.launch({ headless: true });
        for (const viewport of [{ width: 1280, height: 800 }, { width: 393, height: 852 }]) {
            const page = await browser.newPage({ viewport, serviceWorkers: 'block' });
            page.on('dialog', dialog => dialog.dismiss());
            await page.goto(`http://127.0.0.1:${service.address().port}`);
            await page.waitForFunction(() => typeof handleMessageInputPaste === 'function' && document.documentElement.dataset.raiAuthState === 'anonymous');
            await page.evaluate(() => { showApp(); appState.token = 'offline-fixture'; appState.user = { id: 1 }; });
            const original = '\u4e2d\u6587\ud83d\ude80\r\n\t' + 'x'.repeat(4001) + '\nend';
            const result = await page.evaluate(async text => {
                const input = document.getElementById('messageInput');
                input.value = 'Existing draft';
                const clipboard = new DataTransfer();
                clipboard.setData('text/plain', text);
                const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard });
                input.dispatchEvent(event);
                if (pendingAttachmentUpload) await pendingAttachmentUpload;
                return { prevented: event.defaultPrevented, value: input.value, count: currentAttachments.length, name: currentAttachments[0]?.fileName };
            }, original);
            assert.equal(result.prevented, true);
            assert.equal(result.value, 'Existing draft');
            assert.equal(result.count, 1);
            assert.match(result.name, /^pasted-text-\d+\.txt$/);
            assert.deepEqual(uploads.at(-1).bytes, Buffer.from(original, 'utf8'), 'multipart TXT bytes must preserve the pasted text');
            await page.evaluate(async () => {
                removeAttachment();
                const clipboard = new DataTransfer();
                clipboard.setData('text/plain', 'x'.repeat(4000));
                const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard });
                document.getElementById('messageInput').dispatchEvent(event);
                if (event.defaultPrevented) throw new Error('4000 characters must use normal paste');
                const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXb8AAAAASUVORK5CYII='), c => c.charCodeAt(0));
                const first = processUploadedFiles(Array.from({ length: 5 }, (_, i) => new File([png], `image-${i}.png`, { type: 'image/png' })));
                const second = processUploadedFiles(Array.from({ length: 4 }, (_, i) => new File(['text'], `note-${i}.txt`, { type: 'text/plain' })));
                await Promise.all([first, second]);
            });
            assert.equal(await page.locator('.attachment-preview').count(), 9);
            const beforeLimit = uploads.length;
            assert.equal(await page.evaluate(() => processUploadedFiles([new File(['extra'], 'tenth.txt', { type: 'text/plain' })])), 0);
            assert.equal(uploads.length, beforeLimit, 'tenth file must not start an upload');
            assert.equal(await page.evaluate(() => currentAttachments.length), 9);
            failUploads = true;
            await page.evaluate(() => removeAttachment());
            await page.evaluate(async text => handleMessageInputPaste({ clipboardData: { files: [], items: [], getData: () => text }, preventDefault() {} }), original);
            assert.equal(await page.evaluate(() => currentAttachments.length), 0);
            assert.equal(await page.locator('#messageInput').inputValue(), 'Existing draft');
            failUploads = false;
            let releaseUpload;
            uploadGate = new Promise(resolve => { releaseUpload = resolve; });
            const beforeClear = uploads.length;
            await page.evaluate(() => { window.fixtureUpload = processUploadedFiles([new File(['pending'], 'pending.txt', { type: 'text/plain' })]); });
            await new Promise((resolve, reject) => {
                const started = Date.now();
                const timer = setInterval(() => {
                    if (uploads.length > beforeClear) { clearInterval(timer); resolve(); }
                    else if (Date.now() - started > 5000) { clearInterval(timer); reject(new Error('Upload did not start')); }
                }, 20);
            });
            await page.evaluate(() => removeAttachment());
            releaseUpload(); uploadGate = null;
            assert.equal(await page.evaluate(() => window.fixtureUpload), 0, 'cleared draft must reject a late upload');
            assert.equal(await page.evaluate(() => currentAttachments.length), 0);
            await page.close();
        }
        console.log(`attachment-composer: ${engine.name()} desktop/mobile real paste, UTF-8 upload, mixed nine-file queue, overflow, failure and clear race passed`);
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => service.close(resolve));
    }
}

(async () => {
    await serverCases();
    if (process.argv.includes('--browser')) await browserCases();
})().catch(error => { console.error(error); process.exitCode = 1; });
