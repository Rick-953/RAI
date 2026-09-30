'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const prompt = require('../public/rai-system-prompt');
const {getSkillCatalog} = require('../lib/skill-registry');
const source = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
const server = fs.readFileSync(require.resolve('../server.js'), 'utf8');
const opts = {promptLanguage:'zh-CN',modelIdentity:'智能模型',skillCatalog:getSkillCatalog()};
const a = prompt.buildEffectiveSystemPrompt({...opts, time: '2026-09-28', handedness:'left'});
const b = prompt.buildEffectiveSystemPrompt({...opts, time: '2026-09-29', handedness:'right'});
assert.equal(a,b,'dynamic context cannot mutate the system prefix');
assert.ok(a.length < 2300, 'keep the common prompt compact');
assert.ok(!a.includes('make_docx') && !a.includes('zipfile') && !a.includes('settingsPanel-'));
assert.ok(!a.includes('- office:'));
for (const promptLanguage of ['zh-CN', 'zh-TW', 'en']) {
  const stableOptions = { ...opts, promptLanguage };
  const baseline = prompt.buildEffectiveSystemPrompt(stableOptions);
  assert.ok(baseline.length < 2300, promptLanguage + ': preserve compact baseline budget');
  assert.equal(baseline, prompt.buildEffectiveSystemPrompt({
    ...stableOptions, time: '2030-01-01', handedness: 'left',
    userQuestion: 'What is Lao Cha?', messages: [{role: 'user', content: 'Edit this'}],
    searchResults: ['new source'], memories: ['new fact'], toolResults: ['new result']
  }), promptLanguage + ': per-turn question, history, memory and tools must not mutate the baseline');
  assert.ok(prompt.buildEffectiveSystemPrompt({ ...stableOptions, includeMemory: true }).startsWith(baseline),
    promptLanguage + ': memory capability remains a suffix, not a prefix replacement');
  assert.ok(prompt.buildEffectiveSystemPrompt({ ...stableOptions, customPrompt: 'Prefer short answers.' }).startsWith(baseline),
    promptLanguage + ': personal preferences must follow the common prefix');
  for (const skill of getSkillCatalog()) {
    assert.ok(baseline.includes('- ' + skill.name + ': '), 'retain capability: ' + skill.name);
  }
  const policy = baseline.split('\n').find(line => line.includes('rai_ask_user'));
  assert.ok(policy && baseline.indexOf(policy) < baseline.indexOf('## Layer 1'),
    'clarification is baseline policy, available before reading any skill');
  const payload = JSON.parse(policy.match(/\{[^\n]*\}/)[0]);
  assert.equal(typeof payload.question, 'string');
  assert.ok(payload.options.length >= 2 && payload.options.every(option => typeof option === 'string'));
  assert.equal(typeof payload.placeholder, 'string');
}

const start=source.indexOf('function getHandednessPromptHint()');
const end=source.indexOf('// 动态生成系统提示词',start);
const context={appState:{handednessEnabled:true,handedness:'right'},isHandednessMobileLayout:()=>true,normalizeHandedness:x=>x,getShortUserTimeHint:()=> '2026-09-28 23:30',navigator:{standalone:true},Date};
vm.createContext(context);vm.runInContext(source.slice(start,end),context);
const suffix=context.appendUserTurnContextHintForPrompt('Hello');
assert.match(suffix,/^Hello\n\[ctx /);assert.match(suffix,/ui=ios-pwa hand=R\]$/);
assert.ok(suffix.length - 5 < 90, 'small dynamic metadata');
const stripStart=server.indexOf('function stripInlinePromptTimeHint(');const stripEnd=server.indexOf('function buildPromptContextTrace',stripStart);
vm.runInContext(server.slice(stripStart,stripEnd),context);assert.equal(context.stripInlinePromptTimeHint(suffix),'Hello');
assert.match(server,/let systemContent = systemPrompt \|\| ''/);
assert.doesNotMatch(server, /let systemContent = searchContext/);
console.log(JSON.stringify({result:'PASS',systemChars:a.length,userContextChars:suffix.length-5,skills:getSkillCatalog().length}));

assert.doesNotMatch(server, /appendTrustedSkillToCanonicalSystemMessage/);
assert.match(server, /result: buildTrustedSkillResult\(trustedSkill\)/);
