'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    buildEditScript,
    normalizeEditedFileName,
    normalizeEditableExtension
} = require('../lib/file-edit');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const sandboxSkill = fs.readFileSync(path.join(root, 'skills', 'sandbox', 'SKILL.md'), 'utf8');

function createZip(filePath, entries) {
    const payload = Buffer.from(JSON.stringify(entries), 'utf8').toString('base64');
    const code = 'import base64,json,sys,zipfile; entries=json.loads(base64.b64decode(sys.argv[2]).decode()); z=zipfile.ZipFile(sys.argv[1],"w",zipfile.ZIP_DEFLATED); [z.writestr(k,v) for k,v in entries.items()]; z.close()';
    const result = childProcess.spawnSync('python3', ['-c', code, filePath, payload], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || 'fixture zip creation failed');
}

function readZipEntry(filePath, wantedName) {
    const code = 'import sys,zipfile; sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1],"r").read(sys.argv[2]))';
    const result = childProcess.spawnSync('python3', ['-c', code, filePath, wantedName], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || `missing ${wantedName}`);
    return result.stdout;
}

function runEdit(workspace, extension, oldText, newText) {
    const script = buildEditScript({
        extension,
        replacements: [{ old_text: oldText, new_text: newText }],
        workspacePath: workspace
    });
    const result = childProcess.spawnSync('/bin/sh', ['-c', script], {
        cwd: workspace,
        encoding: 'utf8',
        timeout: 15000
    });
    assert.equal(result.status, 0, `${extension} edit failed: ${result.stderr || result.stdout}`);
}

(async () => {
    assert.equal(normalizeEditableExtension('.docx'), 'docx');
    assert.throws(() => normalizeEditableExtension('pdf'), /file_edit_type_blocked/);
    assert.equal(normalizeEditedFileName('../changed.exe', 'source.docx'), 'changed.docx');
    assert.match(server, /name: 'edit_file'/);
    assert.match(server, /buildEditScript\(\{/);
    assert.match(server, /const sourcePath = path\.resolve\(uploadsRoot, row\.filename\)/);
    assert.match(server, /path: sourcePath/);
    assert.match(server, /文件工具执行失败: tool=\$\{toolName\}, code=\$\{safeToolErrorCode\}/);
    assert.match(sandboxSkill, /edit_file/);
    assert.match(sandboxSkill, /ZIP.*7z.*tar.*gzip.*bzip2.*xz/is);

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rai-file-edit-'));
    try {
        const textDir = path.join(tempRoot, 'text');
        fs.mkdirSync(textDir);
        fs.writeFileSync(path.join(textDir, 'sample.csv'), 'name,value\nalpha,1\n', 'utf8');
        runEdit(textDir, 'csv', 'alpha', 'beta');
        assert.equal(fs.readFileSync(path.join(textDir, 'sample.csv'), 'utf8'), 'name,value\nalpha,1\n');
        assert.equal(fs.readFileSync(path.join(textDir, 'edited.csv'), 'utf8'), 'name,value\nbeta,1\n');

        const fixtures = [
            {
                extension: 'docx',
                part: 'word/document.xml',
                xml: '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>SQL prac</w:t></w:r><w:r><w:t>tice</w:t></w:r></w:p></w:body></w:document>'
            },
            {
                extension: 'xlsx',
                part: 'xl/sharedStrings.xml',
                xml: '<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><r><t>SQL prac</t></r><r><t>tice</t></r></si></sst>'
            },
            {
                extension: 'pptx',
                part: 'ppt/slides/slide1.xml',
                xml: '<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><a:p><a:r><a:t>SQL prac</a:t></a:r><a:r><a:t>tice</a:t></a:r></a:p></p:cSld></p:sld>'
            }
        ];

        for (const fixture of fixtures) {
            const dir = path.join(tempRoot, fixture.extension);
            fs.mkdirSync(dir);
            const sourcePath = path.join(dir, `sample.${fixture.extension}`);
            await createZip(sourcePath, { [fixture.part]: fixture.xml });
            runEdit(dir, fixture.extension, 'SQL practice', 'SQL handbook');
            const originalXml = await readZipEntry(sourcePath, fixture.part);
            const editedXml = await readZipEntry(path.join(dir, `edited.${fixture.extension}`), fixture.part);
            assert(originalXml.includes('SQL prac') && originalXml.includes('tice'), `${fixture.extension} original changed`);
            assert.equal(editedXml.includes('SQL handbook'), false, 'replacement may remain split across OOXML runs');
            assert(editedXml.replace(/<[^>]+>/g, '').includes('SQL handbook'), `${fixture.extension} replacement missing`);
        }
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }

    console.log('file-edit-regression ok (text, CSV, DOCX, XLSX, PPTX)');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
