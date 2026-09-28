'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_SKILL_BYTES = 16 * 1024;
const SKILL_ROOT = path.resolve(__dirname, '..', 'skills');
const SKILL_MANIFEST = Object.freeze({
    'web_sources': Object.freeze({ description: "Search and citations.", sha256: '075442c7d04d81b071ee008082068fdb146967b7637d66f720b759e002471877' }),
    'image_generation': Object.freeze({ description: "Image generation.", sha256: '011c948e28bb135cb3d1ea3cc35e37bd5e44ed8917af09bb14c412e3db234414' }),
    'ask_user': Object.freeze({ description: "Choice questions.", sha256: '3dc0a862bda613c801fe0fa2449a6dc77fcb35e15220960851b951c228ecf81e' }),
    'mermaid': Object.freeze({ description: "Diagrams.", sha256: 'f36344f2c39a572f75cbe4c6f4be300c2d4c6d609e535ed3d98db38672a1055f' }),
    'memory': Object.freeze({ description: "Long-term memory.", sha256: 'f2d8bca510332edb4e95b85fb58eb5006335a7bc097133e038e7f0fdeda80697' }),
    'rai-product': Object.freeze({ description: "RAI product details.", sha256: '542d2f8051378b311bed425ff60e81d6762a24d741d89c2412e49b955b499daf' }),
    'sandbox': Object.freeze({ description: "Sandbox files and execution.", sha256: '8ab77993864ec9d229498cd87552bcba79b7dd43694f0765b09f88bb10674fe9' }),
    'documents': Object.freeze({ description: "Word DOCX creation and editing.", sha256: '98f414bdc68aba75fc583f4ff8b0e0bdd39372ef387b3f3330019ed3c960daef' }),
    'spreadsheets': Object.freeze({ description: "Excel XLSX and CSV creation, formulas and validation.", sha256: '62e3459ff36d854f14bf4ccaf33797edab1921ba13969ade04ee3f77a4ce9de5' }),
    'presentations': Object.freeze({ description: "PowerPoint PPTX creation and editing.", sha256: '32532af024a40a2c9c9937e550a105ef5210898b28713148dab189d7738a655b' }),
    'rai-web-ui': Object.freeze({ description: "RAI Web controls and settings by device.", sha256: '4d6004580a662498f83c7eb1c5a56cf6742ad10adda371b73fa975c1c5fcb506' }),
    'cx-rai-ui': Object.freeze({ description: "Native CX RAI controls, settings and platform limits.", sha256: '15b4fde9b611a50b0dd1d45805d30c93fa2916e890d8e025b0c391d7a59e4d87' })
});

function getSkillPath(name) {
    if (!Object.hasOwn(SKILL_MANIFEST, name)) return null;
    return path.join(SKILL_ROOT, name, 'SKILL.md');
}

function parseSkillFile(name, source) {
    const match = String(source).match(/^---\r?\nname: ([a-z0-9_-]+)\r?\ndescription: ([^\r\n]+)\r?\n---\r?\n\r?\n([\s\S]+)$/);
    if (!match || match[1] !== name || match[2] !== SKILL_MANIFEST[name].description) {
        throw new Error(`invalid skill frontmatter: ${name}`);
    }
    return match[3].trim();
}

function loadTrustedSkill(name) {
    const normalizedName = String(name || '').trim();
    const skillPath = getSkillPath(normalizedName);
    if (!skillPath) throw new Error('unknown skill name');
    const rootPrefix = `${SKILL_ROOT}${path.sep}`;
    if (!skillPath.startsWith(rootPrefix)) throw new Error('invalid skill path');
    const source = fs.readFileSync(skillPath, 'utf8');
    const byteLength = Buffer.byteLength(source, 'utf8');
    if (byteLength === 0 || byteLength > MAX_SKILL_BYTES) throw new Error(`invalid skill size: ${normalizedName}`);
    const sha256 = crypto.createHash('sha256').update(source, 'utf8').digest('hex');
    if (sha256 !== SKILL_MANIFEST[normalizedName].sha256) throw new Error(`skill manifest mismatch: ${normalizedName}`);
    return Object.freeze({ name: normalizedName, content: parseSkillFile(normalizedName, source), sha256, byteLength });
}

function validateSkillRegistry() {
    return Object.freeze(Object.keys(SKILL_MANIFEST).map((name) => loadTrustedSkill(name)));
}

function getSkillCatalog() {
    return Object.freeze(Object.entries(SKILL_MANIFEST).map(([name, entry]) => Object.freeze({ name, description: entry.description })));
}

module.exports = Object.freeze({ MAX_SKILL_BYTES, SKILL_MANIFEST, getSkillCatalog, loadTrustedSkill, validateSkillRegistry });
