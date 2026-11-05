'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
function between(source, start, end) {
    const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
    assert.ok(a >= 0 && b > a);
    return source.slice(a, b);
}
const context = vm.createContext({ removeInternalAssistantSections: text => text });
vm.runInContext(`
const TITLE_START_TOKEN='[TITLE]', TITLE_END_TOKEN='[/TITLE]';
const FINAL_ANSWER_TOKEN='[RAI_FINAL]';
const CANVAS_OPS_START_TOKEN='[CANVAS_OPS]', CANVAS_OPS_END_TOKEN='[/CANVAS_OPS]';
const STRUCTURED_OUTPUT_TOKENS=[TITLE_START_TOKEN,TITLE_END_TOKEN,CANVAS_OPS_START_TOKEN,CANVAS_OPS_END_TOKEN,FINAL_ANSWER_TOKEN,'[/RAI_FINAL]'];
${between(server, 'function trimStructuredTokenPrefix(', 'function parseCanvasPatchPayload(')}
${between(server, 'function extractLegacyTrailingTitle(', 'function sanitizeGeneratedConversationTitle(')}
${between(server, 'function sanitizeAssistantVisibleContent(', 'function shouldHoldAssistantVisibleContent(')}
${between(app, 'const TITLE_MARKER_REGEX =', 'function isDefaultConversationTitle(')}
`, context);
let checks = 0;
for (const [raw, expected] of [
    ['Report ready[/TITLE]', 'Report ready'],
    ['Report ready[title]Report[/title]', 'Report ready'],
    ['Report ready[TITLE]unfinished', 'Report ready'],
    ['Report ready[/TiTlE][/TITLE]', 'Report ready'],
    ['Straße 完成😀[TiTlE]报告[/tItLe]', 'Straße 完成😀'],
    ['Before[/TITLE] after', 'Before after'],
    ['Report[RAI_FINAL]Done', 'ReportDone'],
    ['Report[rai_final]Done[/rai_final]', 'ReportDone'],
    ['Values [1, 2] stay', 'Values [1, 2] stay']
]) {
    for (let length = 1; length <= raw.length; length++) {
        const partial = raw.slice(0, length);
        context.input = partial;
        const visible = vm.runInContext('parseStructuredAssistantOutput(input).visibleContent', context);
        const browser = vm.runInContext('stripTrailingTitleMarker(input)', context);
        assert.doesNotMatch(visible, /\[\/?t(?:i(?:t(?:l(?:e)?)?)?)?(?:\]|$)/i);
        assert.doesNotMatch(browser, /\[\/?t(?:i(?:t(?:l(?:e)?)?)?)?(?:\]|$)/i);
        checks += 2;
    }
    context.input = raw;
    assert.equal(vm.runInContext('parseStructuredAssistantOutput(input).visibleContent', context), expected);
    assert.equal(vm.runInContext('sanitizeAssistantVisibleContent(input)', context), expected);
    assert.equal(vm.runInContext('stripTrailingTitleMarker(input)', context), expected);
    checks += 3;
}
context.input = 'Answer[title]会话标题[/title]';
assert.equal(vm.runInContext('parseStructuredAssistantOutput(input).extractedTitle', context), '会话标题');
for (const prefix of ['Progress\n\n', 'Straße 完成😀\n', '[TITLE]Title[/TITLE]报告\n']) {
    context.input = prefix + '[RAI_FINAL]交付';
    const result = vm.runInContext('parseStructuredAssistantOutput(input)', context);
    assert.equal(result.visibleContent.slice(result.finalAnswerOffset), '交付');
    for (let length = 1; length <= '[RAI_FINAL]'.length; length++) {
        context.input = prefix + '[RAI_FINAL]'.slice(0, length);
        assert.doesNotMatch(vm.runInContext('parseStructuredAssistantOutput(input).visibleContent', context), /\[RAI_/i);
        assert.doesNotMatch(vm.runInContext('stripTrailingTitleMarker(input)', context), /\[RAI_/i);
        checks += 2;
    }
}
console.log(`PASS: ${checks + 1} production server/browser title, orphan marker, Unicode and streaming-boundary assertions`);
