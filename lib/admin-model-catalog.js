'use strict';

const PROFILES = Object.freeze(['auto', 'low', 'medium', 'high', 'xhigh', 'max']);
function invalid(message) { const error = new Error(message); error.status = 400; error.code = 'invalid_model_definition'; return error; }
function normalizeAdminModelDefinition(input = {}) {
    const id = String(input.id || '').trim();
    const name = String(input.name || '').trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/.test(id) || ['auto', 'fast-auto', 'think-auto', '__proto__', 'constructor', 'prototype'].includes(id)) throw invalid('模型 ID 无效或暂不开放');
    if (!name || name.length > 80 || /[\u0000-\u001f]/.test(name)) throw invalid('模型名称须为 1–80 个字符');
    const provider = input.provider || 'rai_gpt_gateway';
    if (!['rai_gpt_gateway', 'rai_fast_gateway', 'rai_luna_gateway', 'deepseek'].includes(provider)) throw invalid('请选择已配置的 GPT、Fast 或官方 DeepSeek 线路');
    const supportsThinking = input.supportsThinking !== false;
    if (input.thinkingProfiles !== undefined && !Array.isArray(input.thinkingProfiles)) throw invalid('思考等级必须为数组');
    const allowedProfiles = provider === 'deepseek' ? ['auto', 'high', 'max'] : PROFILES;
    const profiles = input.thinkingProfiles || allowedProfiles;
    if (profiles.some(value => !allowedProfiles.includes(value))) throw invalid('思考等级无效');
    const thinkingProfiles = supportsThinking ? PROFILES.filter(level => profiles.includes(level)) : [];
    if (supportsThinking && !thinkingProfiles.length) throw invalid('请选择模型支持的思考等级');
    const limits = {};
    for (const tier of ['free', 'pro', 'max']) {
        const value = Number(input.limits?.[tier] ?? ({ free: 50, pro: 100, max: 200 }[tier]));
        if (!Number.isInteger(value) || value < 0 || value > 100000) throw invalid('对话额度须为 0–100000 的整数');
        limits[tier] = value;
    }
    const pointCost = Number(input.pointCost ?? 0);
    if (!Number.isInteger(pointCost) || pointCost < 0 || pointCost > 10000) throw invalid('积分须为 0–10000 的整数');
    const isDeepSeek = provider === 'deepseek' || id.startsWith('deepseek');
    const contextWindow = Number(input.contextWindow ?? (isDeepSeek ? 1000000 : 272000));
    const compressionThreshold = Number(input.compressionThreshold ?? (isDeepSeek ? 400000 : 258000));
    if (!Number.isInteger(contextWindow) || contextWindow < 16384 || contextWindow > 2000000 || !Number.isInteger(compressionThreshold) || compressionThreshold < 4096 || compressionThreshold >= contextWindow) throw invalid('压缩阈值必须低于上下文硬上限');
    return { id, name, provider, builtin: false, group: '全部模型', enabled: input.enabled !== false,
        vision: input.vision !== false, contextWindow, compressionThreshold, supportsThinking,
        canDisableThinking: !supportsThinking || input.canDisableThinking === true, thinkingProfiles, limits, pointCost };
}
function validateReasoningProfile(model, profile) {
    return profile === 'none' ? model?.canDisableThinking === true
        : model?.supportsThinking === true && model.thinkingProfiles.includes(profile);
}
module.exports = { PROFILES, normalizeAdminModelDefinition, validateReasoningProfile };
