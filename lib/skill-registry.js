'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_SKILL_BYTES = 16 * 1024;
const SKILL_ROOT = path.resolve(__dirname, '..', 'skills');
const SKILL_MANIFEST = Object.freeze({
    web_sources: Object.freeze({ description: 'Search current web sources and cite supplied results.', sha256: '0d41a399614146c6e7868d818104c6921ab6be59772cb773f6818cbbb551f94a' }),
    image_generation: Object.freeze({ description: 'Generate an image through the configured server-side image tool.', sha256: '1a34cc41df8db452fc309151f4beb9a79755248d16df1800724cdeaf29d69b0e' }),
    ask_user: Object.freeze({ description: 'Ask for a necessary user decision with the RAI ask-user block.', sha256: '7f3e7918727f73e26e179242dd1af5805ba198b88926d0a8518670ac56b86d73' }),
    mermaid: Object.freeze({ description: 'Render supported diagrams using standalone Mermaid code blocks.', sha256: '631ecd48c6266a9d1023ec260e22d416e75fc34b3ddee6a905761f55868b503f' }),
    memory: Object.freeze({ description: 'Use long-term memory tools only for durable user-provided facts.', sha256: '4104e3d467a0d910c6b9a40cba4d3fb49a2b4141f0c4e5a844f1675facdb9ea6' }),
    'rai-product': Object.freeze({ description: 'Answer stable questions about RAI, CX RAI, their creators, supported clients, capabilities, and relationship. Use before web search whenever the user asks what RAI or CX RAI is, who made it, which platforms it supports, or how the two products relate.', sha256: '02fa300ead7578559fc35070cfd2097a31c479179cf75e25d5d8b9c9a1cb21d5' }),
    'sandbox': Object.freeze({ description: 'Use the isolated Linux sandbox for uploaded files, archives, filesystem operations, code execution, and bounded downloadable artifacts. Load it before reading or modifying files, unpacking or creating archives, running code, or inspecting the sandbox runtime.', sha256: '1dbca5ffec96ea8f4dff41220a02ef461823e617d4881ee969e8b69ea9d38c31' }),
    office: Object.freeze({ description: 'Create new Word, Excel, or PowerPoint documents using Python standard-library OOXML templates (zipfile + XML).', sha256: '9b8ea65d7e12cd4530e6dfe2e2c22f82bce729112380893248f8f1587f7f0938' })
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
