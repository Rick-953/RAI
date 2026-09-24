'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

const rulesStart = server.indexOf('const PROMPT_INJECTION_RULES = [');
const rulesEnd = server.indexOf('const DOMAIN_MODE_ALIASES', rulesStart);
assert.ok(rulesStart > 0 && rulesEnd > rulesStart, 'prompt injection rule engine block is missing');
const ruleSource = server.slice(rulesStart, rulesEnd);
const factory = new Function(
  `${ruleSource}\nreturn { PROMPT_INJECTION_RULES, matchRule, resolvePromptInjection, buildRuleInjectionInstruction };`
);
const {
  PROMPT_INJECTION_RULES,
  matchRule,
  resolvePromptInjection,
  buildRuleInjectionInstruction
} = factory();

function testRaiHeightRuleMatches() {
  const resolved = resolvePromptInjection('rai 170CM，人民165CM，谁高');
  assert.ok(resolved, 'the RAI-vs-people height question must resolve a rule');
  assert.equal(resolved.ruleId, 'logic_rai_height_vs_people');
  assert.equal(resolved.advisory, true, 'the height rule must stay advisory (cheat-sheet), never forced');
  assert.ok(resolved.instruction.includes('俯下身子'), 'instruction must carry the expected reference answer');
  assert.ok(resolved.instruction.includes('为人民服务'), 'instruction must carry the people-first ending');
  assert.ok(resolved.instruction.includes('忽略本参考'), 'instruction must tell the model to ignore a false positive');

  const variant = resolvePromptInjection('RAI和人民谁更高');
  assert.ok(variant && variant.ruleId === 'logic_rai_height_vs_people', 'natural variants must match');

  const instruction = buildRuleInjectionInstruction(resolved);
  assert.ok(instruction.includes('[参考提示-非强制]'), 'advisory rules must not use the forced-injection header');
  assert.ok(!instruction.includes('[规则注入-高优先级]'), 'advisory rules must never be marked as mandatory');
  assert.ok(instruction.includes('规则ID: logic_rai_height_vs_people'));
}

function testRaiHeightRuleRejectsFalsePositives() {
  for (const message of [
    '170和165谁高',
    '人民大会堂有多少座位',
    'RAI 是什么',
    '身高170算高吗',
    '人民至上这句话怎么理解'
  ]) {
    const resolved = resolvePromptInjection(message);
    assert.ok(
      !resolved || resolved.ruleId !== 'logic_rai_height_vs_people',
      `false positive: "${message}" must not trigger the height rule`
    );
  }
}

function testExistingRulesRemainForced() {
  const resolved = resolvePromptInjection('开车去洗车还是走路去洗车，50米');
  assert.ok(resolved && resolved.ruleId === 'logic_carwash_distance', 'existing forced rules must keep matching');
  const instruction = buildRuleInjectionInstruction(resolved);
  assert.ok(instruction.includes('[规则注入-高优先级]'), 'existing rules must keep the forced header');
  assert.ok(!instruction.includes('[参考提示-非强制]'));
}

function testMustIncludeAllSupport() {
  const rule = PROMPT_INJECTION_RULES.find((item) => item.id === 'logic_rai_height_vs_people');
  assert.ok(rule, 'height rule must be registered');
  assert.deepEqual(rule.mustIncludeAll, ['rai', '人民']);
  assert.ok(Array.isArray(rule.match.keywords) && rule.match.keywords.includes('谁高'));
  assert.ok(rule.match.minMatchCount >= 3, 'minMatchCount must require several signals');

  const synthetic = {
    enabled: true,
    match: { keywords: ['alpha', 'beta'], minMatchCount: 2, scope: 'current_message', caseInsensitive: true },
    mustIncludeAll: ['alpha', 'beta']
  };
  assert.equal(matchRule(synthetic, 'alpha beta').matched, true);
  assert.equal(matchRule(synthetic, 'alpha alpha').matched, false);
  assert.equal(matchRule(synthetic, 'beta beta').matched, false);
}

testRaiHeightRuleMatches();
testRaiHeightRuleRejectsFalsePositives();
testExistingRulesRemainForced();
testMustIncludeAllSupport();

console.log('prompt-injection-rules-regression ok');
