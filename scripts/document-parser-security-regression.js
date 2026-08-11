'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yazl = require('yazl');
const { parseDocumentFile } = require('../lib/document-parser');

async function createZip(entries) {
    const zip = new yazl.ZipFile();
    const chunks = [];
    let total = 0;
    const output = new Promise((resolve, reject) => {
        zip.outputStream.on('data', (chunk) => {
            chunks.push(chunk);
            total += chunk.length;
        });
        zip.outputStream.once('error', reject);
        zip.outputStream.once('end', () => resolve(Buffer.concat(chunks, total)));
    });
    for (const entry of entries) {
        zip.addBuffer(Buffer.from(entry.content || ''), entry.name, {
            compress: entry.compress !== false,
            mode: entry.mode ?? 0o100600,
            mtime: new Date('2020-01-01T00:00:00.000Z')
        });
    }
    zip.end({ forceDosTimestamp: true });
    return output;
}

function replaceAllEqualLength(buffer, source, replacement) {
    const sourceBytes = Buffer.from(source);
    const replacementBytes = Buffer.from(replacement);
    assert.strictEqual(sourceBytes.length, replacementBytes.length, 'ZIP name mutation must preserve length');
    const result = Buffer.from(buffer);
    let offset = 0;
    let replacements = 0;
    while ((offset = result.indexOf(sourceBytes, offset)) !== -1) {
        replacementBytes.copy(result, offset);
        offset += replacementBytes.length;
        replacements += 1;
    }
    assert.strictEqual(replacements, 2, `expected local and central ZIP names for ${source}`);
    return result;
}

function setCentralDirectoryUncompressedSize(buffer, entryName, declaredSize) {
    const result = Buffer.from(buffer);
    const expectedName = Buffer.from(entryName);
    let cursor = 0;
    while ((cursor = result.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), cursor)) !== -1) {
        const nameLength = result.readUInt16LE(cursor + 28);
        const extraLength = result.readUInt16LE(cursor + 30);
        const commentLength = result.readUInt16LE(cursor + 32);
        const nameStart = cursor + 46;
        if (result.subarray(nameStart, nameStart + nameLength).equals(expectedName)) {
            result.writeUInt32LE(declaredSize, cursor + 24);
            return result;
        }
        cursor = nameStart + nameLength + extraLength + commentLength;
    }
    throw new Error(`central directory entry not found: ${entryName}`);
}

function markZipEntryEncrypted(buffer, entryName) {
    const result = Buffer.from(buffer);
    const expectedName = Buffer.from(entryName);
    let localUpdated = false;
    let centralUpdated = false;
    for (let cursor = 0; cursor <= result.length - 30; cursor += 1) {
        if (result.readUInt32LE(cursor) === 0x04034b50) {
            const nameLength = result.readUInt16LE(cursor + 26);
            const nameStart = cursor + 30;
            if (result.subarray(nameStart, nameStart + nameLength).equals(expectedName)) {
                result.writeUInt16LE(result.readUInt16LE(cursor + 6) | 0x1, cursor + 6);
                localUpdated = true;
            }
        } else if (result.readUInt32LE(cursor) === 0x02014b50) {
            const nameLength = result.readUInt16LE(cursor + 28);
            const nameStart = cursor + 46;
            if (result.subarray(nameStart, nameStart + nameLength).equals(expectedName)) {
                result.writeUInt16LE(result.readUInt16LE(cursor + 8) | 0x1, cursor + 8);
                centralUpdated = true;
            }
        }
    }
    assert.ok(localUpdated && centralUpdated, `encrypted ZIP mutation failed for ${entryName}`);
    return result;
}

async function writeFixture(tempDir, name, buffer) {
    const filePath = path.join(tempDir, name);
    await fs.promises.writeFile(filePath, buffer, { mode: 0o600 });
    return filePath;
}

async function expectParserError(filePath, kind, expectedCode) {
    const expectedCodes = Array.isArray(expectedCode) ? expectedCode : [expectedCode];
    try {
        await parseDocumentFile(filePath, kind);
        assert.fail(`expected ${expectedCodes.join(' or ')} for ${path.basename(filePath)}`);
    } catch (error) {
        assert.ok(
            expectedCodes.includes(error?.code),
            `unexpected parser error for ${path.basename(filePath)}: ${error?.code || error?.message || 'unknown'}; expected ${expectedCodes.join(' or ')}`
        );
    }
}

async function main() {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rai-document-regression-'));
    const ambientNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    const completed = [];
    try {
        const validDocx = await createZip([{
            name: 'word/document.xml',
            content: '<w:document><w:body><w:p><w:r><w:t>DOCX &amp; safe</w:t></w:r></w:p></w:body></w:document>'
        }]);
        const validXlsx = await createZip([
            { name: 'xl/sharedStrings.xml', content: '<sst><si><t>Shared cell</t></si></sst>' },
            { name: 'xl/worksheets/sheet1.xml', content: '<worksheet><sheetData><row><c t="inlineStr"><is><t>Inline cell</t></is></c></row></sheetData></worksheet>' }
        ]);
        const validPptx = await createZip([{
            name: 'ppt/slides/slide1.xml',
            content: '<p:sld><a:p><a:r><a:t>Slide safe</a:t></a:r></a:p></p:sld>'
        }]);
        const validCsv = Buffer.from('name,value\nalpha,1\n"beta, row",2\n');

        const docxPath = await writeFixture(tempDir, 'valid.docx', validDocx);
        const xlsxPath = await writeFixture(tempDir, 'valid.xlsx', validXlsx);
        const pptxPath = await writeFixture(tempDir, 'valid.pptx', validPptx);
        const csvPath = await writeFixture(tempDir, 'valid.csv', validCsv);
        const [docx, xlsx, pptx, csv] = await Promise.all([
            parseDocumentFile(docxPath, 'docx'),
            parseDocumentFile(xlsxPath, 'xlsx'),
            parseDocumentFile(pptxPath, 'pptx'),
            parseDocumentFile(csvPath, 'csv')
        ]);
        assert.match(docx.text, /DOCX & safe/);
        assert.match(xlsx.text, /Shared cell/);
        assert.match(xlsx.text, /Inline cell/);
        assert.match(pptx.text, /Slide safe/);
        assert.match(csv.text, /\| name \| value \|/);
        assert.match(csv.text, /beta, row/);
        completed.push('valid_docx_xlsx_pptx_csv');

        const traversalBase = await createZip([
            { name: 'word/document.xml', content: '<w:document><w:t>safe</w:t></w:document>' },
            { name: 'safe/xx/item.txt', content: 'temporary regression marker' }
        ]);
        const traversalPath = await writeFixture(
            tempDir,
            'traversal.docx',
            replaceAllEqualLength(traversalBase, 'safe/xx/item.txt', 'safe/../item.txt')
        );
        await expectParserError(traversalPath, 'docx', ['archive_entry_path_traversal', 'office_archive_parse_failed']);
        completed.push('path_traversal_rejected');

        const duplicateBase = await createZip([
            { name: 'word/document.xml', content: '<w:document><w:t>safe</w:t></w:document>' },
            { name: 'word/a0000000.xml', content: 'one' },
            { name: 'word/b0000000.xml', content: 'two' }
        ]);
        const duplicatePath = await writeFixture(
            tempDir,
            'duplicate.docx',
            replaceAllEqualLength(duplicateBase, 'word/b0000000.xml', 'word/a0000000.xml')
        );
        await expectParserError(duplicatePath, 'docx', 'archive_duplicate_entry');
        completed.push('duplicate_entry_rejected');

        const declaredSizeBase = await createZip([{
            name: 'word/document.xml',
            content: '<w:document><w:t>small</w:t></w:document>',
            compress: false
        }]);
        const declaredSizePath = await writeFixture(
            tempDir,
            'declared-size.docx',
            setCentralDirectoryUncompressedSize(declaredSizeBase, 'word/document.xml', (8 * 1024 * 1024) + 1)
        );
        await expectParserError(declaredSizePath, 'docx', ['archive_entry_size_limit', 'office_archive_invalid', 'office_archive_parse_failed']);
        completed.push('declared_size_limit_rejected');

        const highRatioPath = await writeFixture(tempDir, 'ratio.docx', await createZip([{
            name: 'word/document.xml',
            content: Buffer.alloc(512 * 1024, 0x41)
        }]));
        await expectParserError(highRatioPath, 'docx', 'archive_compression_ratio_limit');
        completed.push('compression_ratio_rejected');

        const encryptedPath = await writeFixture(
            tempDir,
            'encrypted.docx',
            markZipEntryEncrypted(validDocx, 'word/document.xml')
        );
        await expectParserError(encryptedPath, 'docx', ['archive_encrypted_entry_blocked', 'office_archive_invalid', 'office_archive_parse_failed']);
        completed.push('encrypted_entry_rejected');

        const symlinkPath = await writeFixture(tempDir, 'symlink-entry.docx', await createZip([{
            name: 'word/document.xml',
            content: 'temporary-link-target',
            mode: 0o120777
        }]));
        await expectParserError(symlinkPath, 'docx', 'archive_special_file_blocked');

        const fifoPath = await writeFixture(tempDir, 'fifo-entry.docx', await createZip([{
            name: 'word/document.xml',
            content: 'temporary-special-entry',
            mode: 0o010600
        }]));
        await expectParserError(fifoPath, 'docx', 'archive_special_file_blocked');
        completed.push('symlink_and_special_modes_rejected');

        const manyEntries = [{ name: 'word/document.xml', content: '<w:document><w:t>safe</w:t></w:document>' }];
        for (let index = 0; index < 512; index += 1) {
            manyEntries.push({ name: `custom/item-${String(index).padStart(4, '0')}.xml`, content: '' });
        }
        const entryCountPath = await writeFixture(tempDir, 'entry-count.docx', await createZip(manyEntries));
        await expectParserError(entryCountPath, 'docx', 'archive_entry_count_limit');
        completed.push('entry_count_limit_rejected');

        const sourceLinkPath = path.join(tempDir, 'source-link.docx');
        await fs.promises.symlink(docxPath, sourceLinkPath);
        await expectParserError(sourceLinkPath, 'docx', 'document_source_not_regular');
        completed.push('source_symlink_rejected');

        const previousConcurrency = process.env.RAI_DOCUMENT_PARSER_CONCURRENCY;
        const previousQueueLimit = process.env.RAI_DOCUMENT_PARSER_QUEUE_LIMIT;
        process.env.RAI_DOCUMENT_PARSER_CONCURRENCY = '1';
        process.env.RAI_DOCUMENT_PARSER_QUEUE_LIMIT = '1';
        try {
            const queueInputs = [docxPath, xlsxPath, pptxPath];
            const queueKinds = ['docx', 'xlsx', 'pptx'];
            const queued = queueInputs.map((filePath, index) => parseDocumentFile(filePath, queueKinds[index]));
            const results = await Promise.allSettled(queued);
            assert.strictEqual(results.filter((item) => item.status === 'fulfilled').length, 2);
            assert.strictEqual(results.filter((item) => item.status === 'rejected' && item.reason?.code === 'document_parser_queue_full').length, 1);
        } finally {
            if (previousConcurrency === undefined) delete process.env.RAI_DOCUMENT_PARSER_CONCURRENCY;
            else process.env.RAI_DOCUMENT_PARSER_CONCURRENCY = previousConcurrency;
            if (previousQueueLimit === undefined) delete process.env.RAI_DOCUMENT_PARSER_QUEUE_LIMIT;
            else process.env.RAI_DOCUMENT_PARSER_QUEUE_LIMIT = previousQueueLimit;
        }
        completed.push('bounded_queue_enforced');

        await assert.rejects(
            parseDocumentFile(docxPath, 'txt'),
            (error) => error?.code === 'document_kind_blocked'
        );
        await assert.rejects(
            parseDocumentFile(docxPath, 'pdf'),
            (error) => error?.code === 'document_kind_blocked'
        );
        completed.push('unsupported_kind_rejected');

        const previousNodeEnv = process.env.NODE_ENV;
        const previousParserProfile = process.env.RAI_DOCUMENT_PARSER_PROFILE;
        process.env.NODE_ENV = 'production';
        process.env.RAI_DOCUMENT_PARSER_PROFILE = 'beta';
        try {
            const sandboxAvailable = process.platform === 'linux'
                && fs.existsSync('/usr/bin/prlimit')
                && fs.existsSync('/usr/bin/bwrap')
                && fs.existsSync(path.join(__dirname, 'rai-document-parser-sandbox.sh'));
            if (sandboxAvailable) {
                const productionResult = await parseDocumentFile(docxPath, 'docx');
                assert.match(productionResult.text, /DOCX & safe/);
            } else {
                await expectParserError(docxPath, 'docx', 'document_parser_sandbox_unavailable');
            }
        } finally {
            if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
            else process.env.NODE_ENV = previousNodeEnv;
            if (previousParserProfile === undefined) delete process.env.RAI_DOCUMENT_PARSER_PROFILE;
            else process.env.RAI_DOCUMENT_PARSER_PROFILE = previousParserProfile;
        }
        completed.push('production_network_isolation_gate');
    } finally {
        if (ambientNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = ambientNodeEnv;
        await fs.promises.rm(tempDir, { recursive: true, force: true });
        assert.strictEqual(fs.existsSync(tempDir), false, 'temporary document fixtures must be removed');
    }

    console.log(`document-parser-security-regression ok (${completed.length}/${completed.length}) ${completed.join(',')}`);
}

main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
});
