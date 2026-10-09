'use strict';
const REASONING_PROFILES = Object.freeze(['low', 'medium', 'high', 'max']);
function applyChatReasoningPolicy(body, { thinkingMode = false, profile = 'auto' } = {}) {
    const automatic = profile === 'auto';
    const level = profile === 'mixed' ? 'max' : (REASONING_PROFILES.includes(profile) ? profile : 'low');
    if (body.model === 'deepseek-v4.1-flash') {
        body.thinking = { type: thinkingMode ? 'enabled' : 'disabled' };
        delete body.reasoning_effort;
        if (thinkingMode && !automatic) body.reasoning_effort = level;
    } else if (['gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-astra'].includes(body.model)) {
        delete body.temperature;
        delete body.top_p;
        delete body.thinking;
        delete body.reasoning_effort;
        // This upstream rejects "none". Off means minimum supported effort + hidden thoughts.
        if (!thinkingMode) body.reasoning_effort = 'low';
        else if (!automatic) body.reasoning_effort = level;
    }
    return body;
}
function officialDeepSeekBody(body, model = 'deepseek-flash') {
    const result = { ...body, model };
    if (result.thinking?.type === 'enabled' && result.reasoning_effort) {
        result.reasoning_effort = result.reasoning_effort === 'high' || result.reasoning_effort === 'max' ? 'max' : 'high';
    }
    return result;
}
module.exports = { REASONING_PROFILES, applyChatReasoningPolicy, officialDeepSeekBody };
