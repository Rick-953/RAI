'use strict';

const MEMORY_CATEGORIES = new Set([
    'identity',
    'profile',
    'preference',
    'interest',
    'ability',
    'weakness',
    'health',
    'relationship',
    'work',
    'other'
]);

const MEMORY_CONTENT_MAX_LENGTH = 360;
const MEMORY_EVIDENCE_MAX_LENGTH = 240;

const SECRET_PATTERN = /(?:api[_ -]?key|secret|token|password|密码|密钥|验证码|恢复码|银行卡|信用卡|身份证|护照号|private\s+key)/i;
const EXPLICIT_MEMORY_PATTERN = /(?:(?:请|帮我)?记住|(?:请|帮我|以后)记得|长期记住)|(?:please\s+remember|remember\s+(?:that|this)|save\s+(?:this|that)|keep\s+(?:this|that)\s+in\s+mind)/i;
const LOW_INFORMATION_PATTERN = /^(?:没事|没啥|(?:那)?还行|一般|随便|都行|你猜|不知道|不清楚|说不好|看情况|哈哈+|呵呵+|嘿嘿+|嗯+|哦+|啊+|好|好的|行|可以|对|不对|是|不是|ok(?:ay)?|fine|maybe|perhaps|not\s+sure|i\s+don'?t\s+know|whatever|you\s+guess)$/i;
const UNCERTAIN_OR_HYPOTHETICAL_PATTERN = /(?:可能|也许|大概|估计|好像|应该|不确定|假如|假设|如果我是|开玩笑|随口说|maybe|perhaps|probably|i\s+guess|not\s+sure|suppose|hypothetically|just\s+kidding)/i;
const ONE_OFF_REQUEST_PATTERN = /^(?:请|帮我|给我|替我|麻烦)(?:写|做|查|找|翻译|总结|解释|修改|生成|打开|删除|发送|提醒)|^(?:please\s+)?(?:write|make|find|search|translate|summarize|explain|edit|generate|open|delete|send|remind)\b/i;
const TRANSIENT_STATE_PATTERN = /^(?:我)?(?:没事|还行|一般)$|(?:今天|现在|刚刚|这会儿|暂时|此刻|today|right\s+now|currently).{0,24}(?:累|困|饿|忙|难过|开心|生气|无聊|没事|不舒服|tired|sleepy|hungry|busy|sad|happy|angry|bored|fine)/i;

function cleanMemoryText(value, maxLength) {
    return String(value || '')
        .normalize('NFKC')
        .replace(/\s+/g, ' ')
        .replace(/[\u0000-\u001F\u007F]/g, '')
        .trim()
        .slice(0, maxLength);
}

function normalizeMemoryCategory(category) {
    const normalized = String(category || '').trim().toLowerCase().replace(/[^a-z_]/g, '');
    return MEMORY_CATEGORIES.has(normalized) ? normalized : 'other';
}

function normalizeSaveMemoryToolArgs(args = {}) {
    const content = cleanMemoryText(args.content || args.memory || '', MEMORY_CONTENT_MAX_LENGTH);
    const evidence = cleanMemoryText(args.evidence || args.user_quote || args.userQuote || '', MEMORY_EVIDENCE_MAX_LENGTH);
    const reason = cleanMemoryText(args.reason || '', 180);
    if (!content || !evidence || !reason) return null;
    return {
        category: normalizeMemoryCategory(args.category),
        content,
        evidence,
        reason
    };
}

function normalizeForEvidenceMatch(value) {
    return String(value || '')
        .normalize('NFKC')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function normalizeForLowInformationCheck(value) {
    return normalizeForEvidenceMatch(value)
        .replace(/^[\s“”‘’"'「」『』]+|[\s“”‘’"'「」『』。，,.!！?？¿~～]+$/g, '')
        .trim();
}

function validateSaveMemoryRequest(args = {}, userMessages = []) {
    const normalizedArgs = normalizeSaveMemoryToolArgs(args);
    if (!normalizedArgs) {
        return { ok: false, code: 'memory_arguments_incomplete', message: '保存记忆需要完整内容、用户原话证据和未来用途。' };
    }

    const { content, evidence } = normalizedArgs;
    if (SECRET_PATTERN.test(content) || SECRET_PATTERN.test(evidence)) {
        return { ok: false, code: 'memory_sensitive_content', message: '敏感凭据或账户秘密不能保存为长期记忆。' };
    }

    const normalizedEvidence = normalizeForEvidenceMatch(evidence);
    const evidenceWasProvidedByUser = (Array.isArray(userMessages) ? userMessages : [])
        .map(normalizeForEvidenceMatch)
        .some((message) => message && message.includes(normalizedEvidence));
    if (!normalizedEvidence || !evidenceWasProvidedByUser) {
        return { ok: false, code: 'memory_evidence_not_user_authored', message: '记忆必须由用户原话直接支持，不能根据助手推测保存。' };
    }

    const explicitMemoryRequest = EXPLICIT_MEMORY_PATTERN.test(evidence);
    const lowInformationEvidence = normalizeForLowInformationCheck(evidence);
    if (!explicitMemoryRequest && LOW_INFORMATION_PATTERN.test(lowInformationEvidence)) {
        return { ok: false, code: 'memory_low_information', message: '寒暄、口头反应或低信息回答不是有用的长期记忆。' };
    }
    if (!explicitMemoryRequest && /[?？¿]/.test(evidence)) {
        return { ok: false, code: 'memory_question_not_fact', message: '问句不能作为新的长期事实保存。' };
    }
    if (!explicitMemoryRequest && UNCERTAIN_OR_HYPOTHETICAL_PATTERN.test(evidence)) {
        return { ok: false, code: 'memory_uncertain_or_hypothetical', message: '不确定、假设或玩笑内容不能保存为长期记忆。' };
    }
    if (!explicitMemoryRequest && ONE_OFF_REQUEST_PATTERN.test(evidence)) {
        return { ok: false, code: 'memory_one_off_request', message: '当前一次性任务不需要保存为长期记忆。' };
    }
    if (!explicitMemoryRequest && TRANSIENT_STATE_PATTERN.test(evidence)) {
        return { ok: false, code: 'memory_transient_state', message: '短暂情绪或当前状态不需要保存为长期记忆。' };
    }

    return { ok: true, args: normalizedArgs, explicitMemoryRequest };
}

function buildMemoryToolPolicyInstruction(language = 'zh') {
    if (language === 'en') {
        return [
            '[TOP-PRIORITY MEMORY RULE]',
            'Memory tools are optional and exceptional. Do not call them on every turn, and do not call them merely because memory is enabled or available.',
            'Call save_memory only when the user\'s own words reveal information that is likely to materially improve future answers across conversations: durable preferences or constraints, recurring goals/projects/workflows, relevant background, important relationships, accessibility or health needs, or a stable communication preference.',
            'Save one atomic, self-contained fact at a time. Provide a short exact quote from the user as evidence and explain how it will help future answers.',
            'Do not save greetings, acknowledgements, casual reactions, passing moods or states, one-off requests, details useful only to the current task, assistant inferences, uncertain/hypothetical/joking statements, common/public facts, or secrets and credentials.',
            'Honor an explicit request to remember useful content unless it is unsafe to store. If a new fact corrects an existing memory, delete the outdated memory and then save the replacement. If the user asks to forget something, call delete_memory only.',
            'Never ask a question solely to collect memory. Use memory tools silently when appropriate; mention saving only when the user explicitly asked you to remember something.'
        ].join('\n');
    }
    return [
        '[最高优先级记忆规则]',
        '记忆工具是按需使用的例外能力，不是每轮都要调用；不得仅因为已开启记忆或工具可用就调用。',
        '只有当用户自己的话透露了“未来跨对话回答中会反复、实质提升帮助质量”的信息时，才调用 save_memory：例如稳定偏好或限制、持续目标/项目/工作流、相关背景、重要关系、无障碍或健康需求、稳定沟通偏好。',
        '每次只保存一条原子化、脱离当前上下文仍可理解的事实；必须提供用户的简短原话作为 evidence，并说明它将如何帮助未来回答。',
        '不要保存：寒暄、应和、随口反应、短暂情绪或状态、一次性请求、只对当前任务有用的细节、助手推测、不确定/假设/玩笑内容、公开常识、密码/密钥/令牌等秘密。',
        '用户明确要求“记住”有用内容时应予保存，除非该内容不安全。新事实更正旧记忆时，先删除过时记忆再保存新值；用户要求忘记时只调用 delete_memory。',
        '不得为了收集记忆而专门追问。适合时静默调用记忆工具；只有用户明确要求记住时，才在回复中简短确认。'
    ].join('\n');
}

module.exports = {
    MEMORY_CATEGORIES,
    buildMemoryToolPolicyInstruction,
    normalizeMemoryCategory,
    normalizeSaveMemoryToolArgs,
    validateSaveMemoryRequest
};
