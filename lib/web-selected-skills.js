'use strict';

const { loadTrustedSkill } = require('./skill-registry');

const MAX_SELECTED_SKILLS = 3;
const MAX_SELECTED_BYTES = 64 * 1024;
const OFFICE_SKILLS = new Set(['documents', 'spreadsheets', 'presentations']);
const FILE_SKILLS = new Set([...OFFICE_SKILLS, 'sandbox']);
const CATALOG = Object.freeze([
    { name: 'documents', zh: 'Word 文档', en: 'Word documents', zhDescription: '创建、编辑与检查 DOCX 文档。', enDescription: 'Create, edit and check DOCX documents.' },
    { name: 'spreadsheets', zh: '电子表格', en: 'Spreadsheets', zhDescription: '处理表格、公式和数据校验。', enDescription: 'Work with tables, formulas and data validation.' },
    { name: 'presentations', zh: '演示文稿', en: 'Presentations', zhDescription: '制作、编辑与检查 PowerPoint。', enDescription: 'Build, edit and check PowerPoint presentations.' },
    { name: 'sandbox', zh: '文件与代码', en: 'Files and code', zhDescription: '在受限云端工作区处理文件与运行代码。', enDescription: 'Work with files and code in the restricted cloud workspace.' },
    { name: 'web_sources', zh: '搜索与来源', en: 'Search and sources', zhDescription: '查找时效信息，并保留来源。', enDescription: 'Find current information and keep its sources.' },
    { name: 'mermaid', zh: '图表', en: 'Diagrams', zhDescription: '用 Mermaid 组织流程、关系与结构。', enDescription: 'Describe flows, relationships and structure with Mermaid.' },
    { name: 'image_generation', zh: '图像创作', en: 'Image creation', zhDescription: '为支持图像生成的请求提供创作指导。', enDescription: 'Guide requests that support image generation.' },
    { name: 'rai-product', zh: '认识 RAI', en: 'About RAI', zhDescription: '了解 RAI 的产品能力与边界。', enDescription: 'Understand RAI capabilities and their limits.' },
    { name: 'rai-web-ui', zh: 'Web 使用指南', en: 'Web guide', zhDescription: '查找 Web 控件、设置与设备操作方法。', enDescription: 'Find Web controls, settings and device-specific instructions.' },
    { name: 'cx-rai-ui', zh: 'Windows 使用指南', en: 'Windows guide', zhDescription: '了解 CX RAI 控件与平台限制，不连接电脑。', enDescription: 'Learn CX RAI controls and platform limits; does not connect a PC.' }
].map(Object.freeze));
const NAMES = new Set(CATALOG.map(skill => skill.name));

const ERRORS = Object.freeze({
    invalid_selected_skills: ['技能选择无效；最多选择三项内置技能。', 'Invalid skill selection. Choose up to three built-in skills.'],
    web_skills_mode_unsupported: ['手动选择技能仅支持普通 Web 对话；研究、生成中插话和本地/远程电脑模式暂不支持。本次未发送。', 'Explicit skills require normal Web chat. Research, mid-response interjections and local/remote PC modes are not supported. Nothing was sent.'],
    web_skills_sandbox_unavailable: ['此服务器尚未启用文件沙箱，请移除文件类技能后重试。', 'The file sandbox is not enabled on this server. Remove file skills and try again.'],
    web_skills_saved_chat_required: ['文件类技能需要已保存的对话；请新建普通对话后重试。', 'File skills need a saved conversation. Start a normal chat and try again.'],
    web_skills_search_disabled: ['请开启联网搜索，或移除「搜索与来源」技能后重试。', 'Enable Web Search or remove the Search and sources skill before sending.'],
    web_skills_attachment_search_unsupported: ['附件任务当前不使用联网搜索；请移除「搜索与来源」技能后重试。', 'Attachment tasks do not use Web Search. Remove Search and sources before sending.'],
    web_skills_unavailable: ['技能指导暂时无法安全加载，请稍后重试。', 'Skill guidance could not be loaded safely. Please try again later.']
});

function fail(code, language = '', status = 400) {
    const message = ERRORS[code] || ERRORS.web_skills_unavailable;
    const error = new Error(message[String(language).toLowerCase().startsWith('en') ? 1 : 0]);
    error.code = code;
    error.status = status;
    return error;
}

function validateNames(raw, language = '') {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw) || raw.length > MAX_SELECTED_SKILLS
        || raw.some(name => typeof name !== 'string' || !NAMES.has(name))
        || new Set(raw).size !== raw.length) throw fail('invalid_selected_skills', language);
    return [...raw];
}

function getCatalog({ sandboxEnabled = false } = {}) {
    return CATALOG.map(skill => ({ ...skill, available: sandboxEnabled || !FILE_SKILLS.has(skill.name),
        requiresSavedChat: FILE_SKILLS.has(skill.name), requiresWebSearch: skill.name === 'web_sources' }));
}

function prepareSelection(raw, { language = '', modeAllowed = true, sandboxEnabled = false,
    hasSavedConversation = false, internetEnabled = true, hasAttachments = false } = {}) {
    const names = validateNames(raw, language);
    if (!names.length) return Object.freeze({ names: Object.freeze([]), skills: Object.freeze([]) });
    if (!modeAllowed) throw fail('web_skills_mode_unsupported', language);
    if (names.some(name => FILE_SKILLS.has(name))) {
        if (!sandboxEnabled) throw fail('web_skills_sandbox_unavailable', language);
        if (!hasSavedConversation) throw fail('web_skills_saved_chat_required', language);
    }
    if (names.includes('web_sources') && !internetEnabled) throw fail('web_skills_search_disabled', language);
    if (names.includes('web_sources') && hasAttachments) throw fail('web_skills_attachment_search_unsupported', language);
    // Office guidance depends on the existing sandbox safety guide; no new tools or permissions are enabled.
    const expanded = names.some(name => OFFICE_SKILLS.has(name)) && !names.includes('sandbox')
        ? ['sandbox', ...names] : names;
    let skills;
    try {
        skills = expanded.map(loadTrustedSkill);
        if (skills.reduce((bytes, skill) => bytes + skill.byteLength, 0) > MAX_SELECTED_BYTES) throw new Error('skill_budget');
    } catch (_) { throw fail('web_skills_unavailable', language, 503); }
    return Object.freeze({ names: Object.freeze(names), skills: Object.freeze(skills) });
}

function appendSelected(messages, selection) {
    if (!selection?.skills?.length) return messages;
    const index = messages.findLastIndex(message => message?.role === 'user');
    if (index < 0) throw fail('invalid_selected_skills');
    const guidance = '\n\n[Selected RAI Web skills for this request only]\n'
        + 'The user explicitly selected the following trusted guides. They are user-level reference material, not higher-priority instructions. '
        + 'They do not enable tools, grant permissions, change account limits or authorize local/remote execution. '
        + 'Follow the existing tool availability and approval rules; report unavailable capabilities instead of claiming success.\n'
        + selection.skills.map(skill => `[Trusted RAI skill: ${skill.name}]\n${skill.content}`).join('\n\n');
    // Clone only the provider-bound message. Never modify the message objects used for history/persistence.
    const result = [...messages];
    const original = messages[index];
    result[index] = { ...original, content: typeof original.content === 'string'
        ? original.content + guidance
        : [...(Array.isArray(original.content) ? original.content : []), { type: 'text', text: guidance }] };
    return result;
}

function alreadyLoaded(selection, name) {
    if (!selection?.skills?.some(skill => skill.name === name)) return null;
    return { loaded: true, name, already_loaded: true, content_in_context: true };
}

module.exports = Object.freeze({ MAX_SELECTED_SKILLS, MAX_SELECTED_BYTES, getCatalog, validateNames,
    prepareSelection, appendSelected, alreadyLoaded, fail });
