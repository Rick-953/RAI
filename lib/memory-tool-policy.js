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
const MAX_MEMORY_BATCH_SIZE = 500;

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
    if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
    if (Object.hasOwn(args, 'memories')) {
        if (!Array.isArray(args.memories) || args.memories.length < 1 || args.memories.length > MAX_MEMORY_BATCH_SIZE
            || ['content', 'category', 'evidence', 'reason'].some(key => Object.hasOwn(args, key))) return null;
        const memories = args.memories.map(item => item && !Object.hasOwn(item, 'memories') ? normalizeSaveMemoryToolArgs(item) : null);
        return memories.every(Boolean) ? { memories } : null;
    }
    if (String(args.content || '').normalize('NFKC').trim().length > MEMORY_CONTENT_MAX_LENGTH
        || String(args.evidence || '').normalize('NFKC').trim().length > MEMORY_EVIDENCE_MAX_LENGTH
        || String(args.reason || '').normalize('NFKC').trim().length > 180) return null;
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
    if (args && Object.hasOwn(args, 'memories')) {
        if (!Array.isArray(args.memories) || args.memories.length < 1 || args.memories.length > MAX_MEMORY_BATCH_SIZE) {
            return { ok: false, code: 'memory_batch_size', message: '单次必须写入 1 至 500 条记忆；本批未写入。' };
        }
        if (['content', 'category', 'evidence', 'reason'].some(key => Object.hasOwn(args, key))) {
            return { ok: false, code: 'memory_arguments_incomplete', message: '请使用单条参数或 memories 数组，不能混用；本批未写入。' };
        }
        const results = args.memories.map(item => item && typeof item === 'object' && !Object.hasOwn(item, 'memories')
            ? validateSaveMemoryRequest(item, userMessages)
            : { ok: false, code: 'memory_arguments_incomplete', message: '每条记忆需要内容、分类、原话证据和未来用途。' });
        const failedIndex = results.findIndex(result => !result.ok);
        if (failedIndex >= 0) return { ...results[failedIndex], failedIndex, message: `第 ${failedIndex + 1} 条：${results[failedIndex].message} 本批未写入。` };
        return { ok: true, args: { memories: results.map(result => result.args) }, explicitMemoryRequest: results.some(result => result.explicitMemoryRequest) };
    }
    const normalizedArgs = normalizeSaveMemoryToolArgs(args);
    if (!normalizedArgs) {
        return { ok: false, code: 'memory_arguments_incomplete', message: '保存记忆需要完整内容、用户原话证据和未来用途。' };
    }

    const { content, evidence } = normalizedArgs;
    if (content.length < 2) return { ok: false, code: 'memory_arguments_incomplete', message: '记忆内容至少需要 2 个字符。' };
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

function validateManualMemoryBatch(items) {
    if (!Array.isArray(items) || items.length < 1 || items.length > MAX_MEMORY_BATCH_SIZE) {
        return { ok: false, code: 'memory_batch_size', message: '单次必须写入 1 至 500 条记忆；本批未写入。' };
    }
    const memories = [];
    for (const [index, item] of items.entries()) {
        const raw = typeof item === 'string' ? item : item?.content;
        const content = typeof raw === 'string' ? raw.normalize('NFKC').replace(/\s+/g, ' ').trim() : '';
        if (content.length < 2 || content.length > MEMORY_CONTENT_MAX_LENGTH || SECRET_PATTERN.test(content)) {
            return { ok: false, code: 'invalid_memory_content', failedIndex: index, message: `第 ${index + 1} 条记忆需为 2 至 360 字且不能包含秘密；本批未写入。` };
        }
        memories.push({ content, category: normalizeMemoryCategory(item?.category) });
    }
    return { ok: true, memories };
}

function buildMemoryToolPolicyInstruction(language = 'zh') {
    return language === 'en'
        ? '[Memory tools] Do not call them on every turn. Only save user-supported durable facts that materially improve future answers; never save secrets or guesses. Before editing, read_skill("memory") on demand unless its guide is already in context. save_memory accepts 1–500 independent memories; delete_memory accepts 1–500 IDs for a user-authorized deletion. Every edit keeps a backup of the previous version. Confirm only actual tool results.'
        : '[记忆工具] 不是每轮都要调用。只保存有用户原话支持、能实质改善未来跨对话回答的稳定事实，不保存秘密或推测。操作前按需 read_skill("memory")；已在本轮上下文中则不重复读取。save_memory 单次 1–500 条，每条独立；delete_memory 单次 1–500 个 ID，删除须有用户授权。每次修改保留修改前版本备份。只依据工具实际结果确认。';
}

module.exports = {
    MEMORY_CATEGORIES,
    MAX_MEMORY_BATCH_SIZE,
    buildMemoryToolPolicyInstruction,
    normalizeMemoryCategory,
    normalizeSaveMemoryToolArgs,
    validateManualMemoryBatch,
    validateSaveMemoryRequest
};
