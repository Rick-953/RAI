'use strict';

const { Tokenizer } = require('@huggingface/tokenizers');
let tokenizer;

function estimateDeepSeekInputTokens(body) {
    tokenizer ||= new Tokenizer(
        require('../resources/tokenizers/deepseek-v4/tokenizer.json'),
        require('../resources/tokenizers/deepseek-v4/tokenizer_config.json'));
    let media = 0, textTokens = 0;
    const text = JSON.stringify({ messages: body.messages || [], tools: body.tools || [], response_format: body.response_format || null }, (key, value) => {
        if (value && ['image_url', 'input_audio', 'video_url'].includes(value.type)) {
            media += 1;
            return { type: value.type };
        }
        if (typeof value === 'string') {
            textTokens += tokenizer.tokenize(value, { add_special_tokens: false }).length;
            return '';
        }
        return value;
    });
    // The published tokenizer counts text; JSON framing and per-message/media reserves cover the unpublished API envelope.
    return textTokens + tokenizer.tokenize(text, { add_special_tokens: false }).length + (body.messages?.length || 0) * 32 + media * 16384;
}

module.exports = { estimateDeepSeekInputTokens };
