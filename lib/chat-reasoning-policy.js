'use strict';
const REASONING_PROFILES = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
function applyChatReasoningPolicy(body, { thinkingMode = false, profile = 'auto', definition = null, provider = '' } = {}) {
    const automatic = profile === 'auto';
    if (definition?.supportsThinking === false) { delete body.reasoning_effort; delete body.thinking; return body; }
    const level = profile === 'mixed' ? 'max' : (REASONING_PROFILES.includes(profile) ? profile : 'low');
    if (provider === 'deepseek' || String(body.model).startsWith('deepseek')) {
        body.thinking = { type: thinkingMode ? 'enabled' : 'disabled' };
        delete body.reasoning_effort;
        if (thinkingMode && !automatic) body.reasoning_effort = level;
    } else if (provider === 'rai_luna_gateway') {
        delete body.temperature; delete body.top_p; delete body.thinking; delete body.reasoning_effort;
        if (!thinkingMode) body.reasoning_effort = 'none';
        else if (!automatic) body.reasoning_effort = level;
    } else if (provider === 'rai_gpt_gateway' || String(body.model).startsWith('gpt-')) {
        delete body.temperature;
        delete body.top_p;
        delete body.thinking;
        delete body.reasoning_effort;
        // This upstream rejects "none". Legacy off uses minimum effort; returned reasoning stays visible.
        if (!thinkingMode) body.reasoning_effort = definition?.canDisableThinking ? 'none' : 'low';
        else if (!automatic) body.reasoning_effort = level;
    } else if (definition) {
        delete body.reasoning_effort;
        body.thinking = { type: thinkingMode ? 'enabled' : 'disabled' };
        if (thinkingMode && !automatic) body.reasoning_effort = level;
    }
    return body;
}
function officialDeepSeekBody(body, model = 'deepseek-flash') {
    const result = { ...body, model };
    if (result.thinking?.type === 'enabled' && result.reasoning_effort) {
        result.reasoning_effort = result.reasoning_effort === 'max' || result.reasoning_effort === 'xhigh' ? 'max' : 'high';
    }
    return result;
}
module.exports = { REASONING_PROFILES, applyChatReasoningPolicy, officialDeepSeekBody };
