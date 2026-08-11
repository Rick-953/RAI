'use strict';

const path = require('path');

const MAX_REPLACEMENTS = 32;
const MAX_REPLACEMENT_BYTES = 64 * 1024;
const EDITABLE_OFFICE_EXTENSIONS = new Set(['docx', 'xlsx', 'pptx']);
const EDITABLE_TEXT_EXTENSIONS = new Set([
    'txt', 'md', 'json', 'xml', 'csv', 'log', 'yaml', 'yml', 'ini', 'conf',
    'html', 'htm', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'java',
    'c', 'cpp', 'h', 'hpp', 'css', 'scss', 'less', 'vue', 'svelte', 'swift',
    'kt', 'go', 'rs', 'sh', 'bash', 'zsh', 'sql', 'php', 'pl', 'rb'
]);

class FileEditError extends Error {
    constructor(code, statusCode = 400) {
        super(code);
        this.name = 'FileEditError';
        this.code = code;
        this.statusCode = statusCode;
    }
}

function normalizeEditableExtension(value) {
    const extension = String(value || '').trim().toLowerCase().replace(/^\./, '');
    if (!EDITABLE_OFFICE_EXTENSIONS.has(extension) && !EDITABLE_TEXT_EXTENSIONS.has(extension)) {
        throw new FileEditError('file_edit_type_blocked', 422);
    }
    return extension;
}

function normalizeEditReplacements(value) {
    if (!Array.isArray(value) || value.length < 1 || value.length > MAX_REPLACEMENTS) {
        throw new FileEditError('file_edit_replacements_invalid', 422);
    }
    const seen = new Set();
    let totalBytes = 0;
    const replacements = value.map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw new FileEditError('file_edit_replacements_invalid', 422);
        }
        const keys = Object.keys(item);
        if (keys.some((key) => !['old_text', 'new_text'].includes(key))) {
            throw new FileEditError('file_edit_replacements_invalid', 422);
        }
        const oldText = typeof item.old_text === 'string' ? item.old_text : '';
        const newText = typeof item.new_text === 'string' ? item.new_text : '';
        if (!oldText || oldText.includes('\u0000') || newText.includes('\u0000') || seen.has(oldText)) {
            throw new FileEditError('file_edit_replacements_invalid', 422);
        }
        const oldBytes = Buffer.byteLength(oldText, 'utf8');
        const newBytes = Buffer.byteLength(newText, 'utf8');
        if (oldBytes > 4096 || newBytes > 8192) {
            throw new FileEditError('file_edit_replacements_invalid', 422);
        }
        totalBytes += oldBytes + newBytes;
        if (totalBytes > MAX_REPLACEMENT_BYTES) {
            throw new FileEditError('file_edit_replacements_too_large', 413);
        }
        seen.add(oldText);
        return { old_text: oldText, new_text: newText };
    });
    return replacements;
}

function normalizeEditedFileName(value, sourceName) {
    const sourceBase = path.basename(String(sourceName || 'file.txt'));
    const extension = normalizeEditableExtension(path.extname(sourceBase));
    const defaultBase = path.basename(sourceBase, path.extname(sourceBase));
    const requested = path.basename(String(value || `${defaultBase}-edited.${extension}`))
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .replace(/[\\/:*?"<>|]/g, '_')
        .trim()
        .slice(0, 128);
    const requestedBase = path.basename(requested || `${defaultBase}-edited.${extension}`, path.extname(requested));
    return `${requestedBase || `${defaultBase}-edited`}.${extension}`;
}

function buildEditScript({ extension, replacements, workspacePath = '/workspace' }) {
    const normalizedExtension = normalizeEditableExtension(extension);
    const normalizedReplacements = normalizeEditReplacements(replacements);
    const normalizedWorkspacePath = path.resolve(String(workspacePath || '/workspace'));
    if (!path.isAbsolute(normalizedWorkspacePath) || normalizedWorkspacePath.length > 512) {
        throw new FileEditError('file_edit_workspace_invalid', 500);
    }
    const payload = Buffer.from(JSON.stringify(normalizedReplacements), 'utf8').toString('base64');
    const officeMode = EDITABLE_OFFICE_EXTENSIONS.has(normalizedExtension);
    return `python3 - <<'PY'
import base64
import io
import json
import re
import sys
import zipfile
from pathlib import Path
import xml.etree.ElementTree as ET

EXT = ${JSON.stringify(normalizedExtension)}
WORKSPACE = Path(${JSON.stringify(normalizedWorkspacePath)})
OUTPUT = WORKSPACE / ('edited.' + EXT)
REPLACEMENTS = json.loads(base64.b64decode(${JSON.stringify(payload)}).decode('utf-8'))
candidates = [p for p in WORKSPACE.iterdir() if p.is_file() and p.suffix.lower() == '.' + EXT and p != OUTPUT]
if len(candidates) != 1:
    print('file_edit_input_invalid', file=sys.stderr)
    raise SystemExit(2)
source = candidates[0]

def apply_replacements(text):
    updated = text
    for item in REPLACEMENTS:
        updated = updated.replace(item['old_text'], item['new_text'])
    return updated

def rewrite_text_nodes(container, text_tag):
    nodes = list(container.iter(text_tag))
    if not nodes:
        return 0
    original_parts = [node.text or '' for node in nodes]
    original = ''.join(original_parts)
    updated = apply_replacements(original)
    if updated == original:
        return 0
    cursor = 0
    for index, node in enumerate(nodes):
        if index == len(nodes) - 1:
            node.text = updated[cursor:]
            break
        width = len(original_parts[index])
        node.text = updated[cursor:cursor + width]
        cursor += width
    return 1

def parse_xml(data):
    for _, item in ET.iterparse(io.BytesIO(data), events=('start-ns',)):
        prefix, uri = item
        try:
            ET.register_namespace(prefix or '', uri)
        except ValueError:
            pass
    return ET.fromstring(data)

def rewrite_office_part(name, data):
    if EXT == 'docx':
        allowed = (
            name == 'word/document.xml'
            or re.fullmatch(r'word/(?:header|footer)\\d+\\.xml', name)
            or name in {'word/footnotes.xml', 'word/endnotes.xml', 'word/comments.xml'}
        )
        if not allowed:
            return data, 0
        namespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
        container_tag = '{%s}p' % namespace
        text_tag = '{%s}t' % namespace
    elif EXT == 'pptx':
        allowed = bool(re.fullmatch(r'ppt/(?:slides/slide|notesSlides/notesSlide)\\d+\\.xml', name))
        if not allowed:
            return data, 0
        namespace = 'http://schemas.openxmlformats.org/drawingml/2006/main'
        container_tag = '{%s}p' % namespace
        text_tag = '{%s}t' % namespace
    else:
        allowed = name == 'xl/sharedStrings.xml' or bool(re.fullmatch(r'xl/worksheets/sheet\\d+\\.xml', name))
        if not allowed:
            return data, 0
        namespace = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
        text_tag = '{%s}t' % namespace
        root = parse_xml(data)
        changes = 0
        for tag in ('{%s}si' % namespace, '{%s}is' % namespace):
            for container in root.iter(tag):
                changes += rewrite_text_nodes(container, text_tag)
        if not changes:
            return data, 0
        return ET.tostring(root, encoding='utf-8', xml_declaration=True), changes

    root = parse_xml(data)
    changes = sum(rewrite_text_nodes(container, text_tag) for container in root.iter(container_tag))
    if not changes:
        return data, 0
    return ET.tostring(root, encoding='utf-8', xml_declaration=True), changes

changes = 0
if ${officeMode ? 'True' : 'False'}:
    with zipfile.ZipFile(source, 'r') as src, zipfile.ZipFile(OUTPUT, 'w') as dst:
        for entry in src.infolist():
            data = src.read(entry.filename)
            if not entry.is_dir() and entry.filename.endswith('.xml'):
                data, part_changes = rewrite_office_part(entry.filename, data)
                changes += part_changes
            dst.writestr(entry, data)
else:
    original = source.read_text(encoding='utf-8')
    updated = apply_replacements(original)
    changes = int(updated != original)
    OUTPUT.write_text(updated, encoding='utf-8')

if changes < 1:
    if OUTPUT.exists():
        OUTPUT.unlink()
    print('file_edit_no_match', file=sys.stderr)
    raise SystemExit(4)
print(json.dumps({'ok': True, 'changed_containers': changes, 'output': OUTPUT.name}))
PY`;
}

module.exports = Object.freeze({
    EDITABLE_OFFICE_EXTENSIONS,
    EDITABLE_TEXT_EXTENSIONS,
    FileEditError,
    MAX_REPLACEMENTS,
    MAX_REPLACEMENT_BYTES,
    buildEditScript,
    normalizeEditableExtension,
    normalizeEditedFileName,
    normalizeEditReplacements
});
