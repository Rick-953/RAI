'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_SKILL_BYTES = 16 * 1024;
const SKILL_ROOT = path.resolve(__dirname, '..', 'skills');
const SKILL_MANIFEST = Object.freeze({
    'web_sources': Object.freeze({ description: "Search and citations.", sha256: '075442c7d04d81b071ee008082068fdb146967b7637d66f720b759e002471877' }),
    'image_generation': Object.freeze({ description: "GPT Image 2.5: named images, 1K, 100-300 points.", sha256: '09b97bc405e4dd33608b89887406c36a804c81ebb1cd357012b261ae912cf469' }),
    'ask_user': Object.freeze({ description: "Choice questions.", sha256: '3dc0a862bda613c801fe0fa2449a6dc77fcb35e15220960851b951c228ecf81e' }),
    'mermaid': Object.freeze({ description: "Diagrams.", sha256: 'f36344f2c39a572f75cbe4c6f4be300c2d4c6d609e535ed3d98db38672a1055f' }),
    'memory': Object.freeze({ description: "Long-term memory.", sha256: 'e479ee8b89e91e0a875556c5864ba35316434ed00900c3213d374b6bdd4d1d94' }),
    'rai-product': Object.freeze({ description: "RAI product details.", sha256: 'cf6505a55c9d2eac72b2b66ae050d09a6bfcb52d05799a3dc9b4f86cd302e85e' }),
    'sandbox': Object.freeze({ description: "Sandbox files and execution.", sha256: '8ab77993864ec9d229498cd87552bcba79b7dd43694f0765b09f88bb10674fe9' }),
    'documents': Object.freeze({ description: "Word DOCX creation and editing.", sha256: 'a3f60f7484c11706cf8982b8ca1c7e94cc8bb133327d4f61f92e38ecf03c209d' }),
    'spreadsheets': Object.freeze({ description: "Excel XLSX and CSV creation, formulas and validation.", sha256: '4921bea17a156854d24208b5f01b5158c36f114c27ca2ddcc831ae27427ada36' }),
    'presentations': Object.freeze({ description: "PowerPoint PPTX creation and editing.", sha256: '57c04e171d8e846a8be52e190b3210658daeec319dbdac0424a4ed56e988b7c2' }),
    'rai-web-ui': Object.freeze({ description: "RAI Web controls and settings by device.", sha256: '9396b134b6ae725479cbe3611ea53b7d926eb9f683daad185e845151154aeb52' }),
    'cx-rai-ui': Object.freeze({ description: "Native CX RAI controls, settings and platform limits.", sha256: 'df36a72a0ba324dac7ffb5c416a17afd711f1d70a7f09c20e7a027e087040245' })
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
