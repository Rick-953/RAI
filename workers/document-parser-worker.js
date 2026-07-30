'use strict';

const yauzl = require('yauzl');

const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 512;
const MAX_ARCHIVE_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_ARCHIVE_RATIO = 200;
const MAX_TARGET_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_PRESENTATION_SLIDES = 200;
const MAX_OUTPUT_CHARS = 100000;
const ALLOWED_KINDS = new Set(['docx', 'xlsx', 'pptx']);

function parserError(code) {
    const error = new Error(code);
    error.code = code;
    return error;
}

function collectStdin() {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        process.stdin.on('data', (chunk) => {
            total += chunk.length;
            if (total > MAX_INPUT_BYTES) {
                reject(parserError('document_input_limit_exceeded'));
                process.stdin.destroy();
                return;
            }
            chunks.push(chunk);
        });
        process.stdin.once('end', () => resolve(Buffer.concat(chunks, total)));
        process.stdin.once('error', reject);
    });
}

function normalizeArchiveEntryName(rawName) {
    const name = String(rawName || '');
    if (!name || name.includes('\0') || name.includes('\\')) {
        throw parserError('archive_entry_name_invalid');
    }
    if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
        throw parserError('archive_entry_absolute_path');
    }
    const segments = name.split('/');
    const effectiveSegments = name.endsWith('/') ? segments.slice(0, -1) : segments;
    if (effectiveSegments.length === 0 || effectiveSegments.some((part) => !part || part === '.' || part === '..')) {
        throw parserError('archive_entry_path_traversal');
    }
    return name;
}

function validateArchiveEntry(entry, totals, seenNames) {
    const name = normalizeArchiveEntryName(entry.fileName);
    if (seenNames.has(name)) throw parserError('archive_duplicate_entry');
    seenNames.add(name);

    totals.entries += 1;
    if (totals.entries > MAX_ARCHIVE_ENTRIES) throw parserError('archive_entry_count_limit');

    if ((entry.generalPurposeBitFlag & 0x1) !== 0) throw parserError('archive_encrypted_entry_blocked');
    if (![0, 8].includes(Number(entry.compressionMethod))) throw parserError('archive_compression_method_blocked');

    const compressedSize = Number(entry.compressedSize || 0);
    const uncompressedSize = Number(entry.uncompressedSize || 0);
    if (!Number.isSafeInteger(compressedSize) || !Number.isSafeInteger(uncompressedSize) || compressedSize < 0 || uncompressedSize < 0) {
        throw parserError('archive_entry_size_invalid');
    }
    if (uncompressedSize > MAX_ARCHIVE_ENTRY_BYTES) throw parserError('archive_entry_size_limit');
    totals.uncompressed += uncompressedSize;
    if (totals.uncompressed > MAX_ARCHIVE_TOTAL_BYTES) throw parserError('archive_total_size_limit');
    if (uncompressedSize > 0 && compressedSize === 0) throw parserError('archive_compression_ratio_invalid');
    if (compressedSize > 0 && uncompressedSize / compressedSize > MAX_ARCHIVE_RATIO) {
        throw parserError('archive_compression_ratio_limit');
    }

    const unixMode = (Number(entry.externalFileAttributes || 0) >>> 16) & 0xffff;
    const fileType = unixMode & 0o170000;
    if (fileType && fileType !== 0o100000 && fileType !== 0o040000) {
        throw parserError('archive_special_file_blocked');
    }
    return name;
}

function shouldReadArchiveEntry(kind, name) {
    if (kind === 'docx') return name === 'word/document.xml';
    if (kind === 'xlsx') {
        return name === 'xl/sharedStrings.xml'
            || /^xl\/worksheets\/sheet\d+\.xml$/.test(name);
    }
    if (kind === 'pptx') return /^ppt\/slides\/slide\d+\.xml$/.test(name);
    return false;
}

function readZipEntry(zipFile, entry, totals) {
    return new Promise((resolve, reject) => {
        zipFile.openReadStream(entry, (openError, stream) => {
            if (openError) return reject(openError);
            const chunks = [];
            let bytes = 0;
            stream.on('data', (chunk) => {
                bytes += chunk.length;
                totals.targetBytes += chunk.length;
                if (bytes > MAX_ARCHIVE_ENTRY_BYTES || totals.targetBytes > MAX_TARGET_TOTAL_BYTES) {
                    stream.destroy(parserError('archive_target_size_limit'));
                    return;
                }
                chunks.push(chunk);
            });
            stream.once('error', reject);
            stream.once('end', () => resolve(Buffer.concat(chunks, bytes)));
        });
    });
}

function inspectOfficeArchive(kind, input) {
    return new Promise((resolve, reject) => {
        yauzl.fromBuffer(input, {
            lazyEntries: true,
            decodeStrings: true,
            validateEntrySizes: true,
            strictFileNames: true
        }, (openError, zipFile) => {
            if (openError) return reject(parserError('office_archive_invalid'));
            const totals = { entries: 0, uncompressed: 0, targetBytes: 0 };
            const seenNames = new Set();
            const targets = new Map();
            let settled = false;

            const fail = (error) => {
                if (settled) return;
                settled = true;
                try { zipFile.close(); } catch (_) {}
                reject(error?.code ? error : parserError('office_archive_parse_failed'));
            };

            zipFile.on('error', fail);
            zipFile.on('entry', (entry) => {
                Promise.resolve().then(async () => {
                    const name = validateArchiveEntry(entry, totals, seenNames);
                    if (shouldReadArchiveEntry(kind, name)) {
                        if (kind === 'pptx' && targets.size >= MAX_PRESENTATION_SLIDES) {
                            throw parserError('presentation_slide_limit');
                        }
                        targets.set(name, await readZipEntry(zipFile, entry, totals));
                    }
                    zipFile.readEntry();
                }).catch(fail);
            });
            zipFile.on('end', () => {
                if (settled) return;
                settled = true;
                resolve({ targets, totals });
            });
            zipFile.readEntry();
        });
    });
}

function decodeXmlEntities(text) {
    return String(text || '')
        .replace(/&#x([0-9a-f]+);/gi, (_, value) => String.fromCodePoint(Math.min(parseInt(value, 16) || 0, 0x10ffff)))
        .replace(/&#(\d+);/g, (_, value) => String.fromCodePoint(Math.min(parseInt(value, 10) || 0, 0x10ffff)))
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

function xmlToPlainText(xml, paragraphTagPattern = '') {
    let text = String(xml || '');
    if (paragraphTagPattern) {
        text = text.replace(new RegExp(`</(?:${paragraphTagPattern})>`, 'gi'), '\n');
    }
    text = text
        .replace(/<(?:w:tab|a:tab)\b[^>]*\/?\s*>/gi, '\t')
        .replace(/<(?:w:br|a:br)\b[^>]*\/?\s*>/gi, '\n')
        .replace(/<[^>]+>/g, ' ');
    return decodeXmlEntities(text)
        .replace(/[ \t]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function extractTextNodes(xml) {
    const values = [];
    const matcher = /<(?:[A-Za-z0-9_-]+:)?t\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?t>/gi;
    let match;
    while ((match = matcher.exec(String(xml || ''))) !== null) {
        const value = decodeXmlEntities(match[1].replace(/<[^>]+>/g, '')).trim();
        if (value) values.push(value);
    }
    return values;
}

async function parseOffice(kind, input) {
    const { targets, totals } = await inspectOfficeArchive(kind, input);
    let text = '';
    if (kind === 'docx') {
        const documentXml = targets.get('word/document.xml');
        if (!documentXml) throw parserError('docx_document_xml_missing');
        text = xmlToPlainText(documentXml.toString('utf8'), 'w:p');
    } else if (kind === 'xlsx') {
        const parts = [];
        const shared = targets.get('xl/sharedStrings.xml');
        if (shared) {
            const sharedValues = extractTextNodes(shared.toString('utf8'));
            if (sharedValues.length) parts.push(`[单元格数据]: ${sharedValues.join(' | ')}`);
        }
        const sheetNames = [...targets.keys()]
            .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
            .sort((a, b) => Number(a.match(/sheet(\d+)/)?.[1] || 0) - Number(b.match(/sheet(\d+)/)?.[1] || 0));
        if (sheetNames.length > 64) throw parserError('workbook_sheet_limit');
        for (const [index, name] of sheetNames.entries()) {
            const inlineValues = extractTextNodes(targets.get(name).toString('utf8'));
            if (inlineValues.length) parts.push(`[工作表${index + 1}]: ${inlineValues.join(' | ')}`);
        }
        if (!parts.length && sheetNames[0]) {
            const fallback = xmlToPlainText(targets.get(sheetNames[0]).toString('utf8'));
            if (fallback) parts.push(`[工作表内容]: ${fallback}`);
        }
        text = parts.join('\n');
    } else if (kind === 'pptx') {
        const slideNames = [...targets.keys()].sort((a, b) => Number(a.match(/slide(\d+)/)?.[1] || 0) - Number(b.match(/slide(\d+)/)?.[1] || 0));
        text = slideNames.map((name, index) => {
            const values = extractTextNodes(targets.get(name).toString('utf8'));
            const value = values.length ? values.join(' ') : xmlToPlainText(targets.get(name).toString('utf8'), 'a:p');
            return value ? `[幻灯片${index + 1}]: ${value}` : '';
        }).filter(Boolean).join('\n');
    }
    return {
        text: text.slice(0, MAX_OUTPUT_CHARS),
        meta: { entries: totals.entries, uncompressedBytes: totals.uncompressed }
    };
}

async function main() {
    const kind = String(process.argv[2] || '').toLowerCase();
    if (!ALLOWED_KINDS.has(kind)) throw parserError('document_kind_blocked');
    const input = await collectStdin();
    if (!input.length) throw parserError('document_input_empty');
    const result = await parseOffice(kind, input);
    process.stdout.write(JSON.stringify({ ok: true, ...result }));
}

main().catch((error) => {
    const code = String(error?.code || error?.message || 'document_parse_failed').replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 160);
    process.stdout.write(JSON.stringify({ ok: false, error: code }));
    process.exitCode = 1;
});
