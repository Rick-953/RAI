'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const policy = require('../lib/client-skill-policy');
const page = { success: true, name: 'documents', offset: 0, total_chars: 12, content: 'BODY_MARKER!', complete: true, next_offset: null };
const raw = { protocol: 1, catalog: [{ name: 'documents', description: 'Word creation' }], selected: [] };
const context = policy.normalizeClientSkills(raw, true);
assert.equal(policy.normalizeClientSkills(raw, false), null);
assert.equal(policy.normalizeClientSkills(null, true), null);
assert.deepEqual(context.selected, []);
assert.ok(!JSON.stringify(policy.appendSelected([{ role: 'user', content: 'Hello' }], context)).includes(page.content));
assert.equal(raw.catalog[0].description, 'Word creation');
assert.equal(policy.appendSelected([], null).length, 0);
const selected = policy.normalizeClientSkills({ ...raw, selected: [page] }, true);
const prompt = policy.appendSelected([{ role: 'user', content: 'Make a file' }], selected);
assert.equal(prompt.length, 3);
assert.ok(prompt.slice(1).every(message => message.role === 'user'));
assert.equal(JSON.stringify(prompt).split(page.content).length - 1, 1);
assert.match(prompt[2].content, /explicitly selected/);
assert.match(prompt[2].content, /not higher-priority/);
const cached = policy.loadedPage(selected, new Map(), 'documents');
assert.equal(cached.already_loaded, true);
assert.ok(!JSON.stringify(cached).includes(page.content));
assert.equal(policy.loadedPage(context, new Map(), 'documents'), null);
assert.equal(policy.loadedPage(selected, new Map(), 'documents', 12), null);
assert.equal(policy.loadedPage(context, new Map([['documents:0', page]]), 'documents').content_in_context, true);
assert.equal(policy.isClientSkillTool('read_skill'), true);
assert.equal(policy.isClientSkillTool('list_skills'), true);
assert.equal(policy.isClientSkillTool('install_skill'), true);
assert.equal(policy.isClientSkillTool('write_file'), false);
const tools = [{ type: 'function', function: { name: 'read_skill', parameters: { properties: { name: { enum: ['cloud-only'] } } } } }];
assert.equal(policy.configureTools(tools, null), tools);
const configured = policy.configureTools(tools, selected);
assert.equal(configured.length, 3);
assert.equal(configured[0].function.parameters.properties.name.enum, undefined);
assert.equal(configured[0].function.parameters.properties.offset.maximum, 120000);
const server = fs.readFileSync(require.resolve('../server.js'), 'utf8');
for (const contract of ['clientSkillPolicy.appendSelected(finalMessages, clientSkills)', 'clientSkillPolicy.configureTools(',
    'clientSkillPolicy.loadedPage(clientSkills, clientSkillPages', 'isReadSkillTool && !isClientSkillTool',
    '(isFileTool || isClientSkillTool || isClientSettingTool) && clientFileExecution', 'clientSkillPolicy.normalizePage(result)']) {
    assert.ok(server.includes(contract), `missing integration: ${contract}`);
}
console.log('client skill request regression passed: unused body isolation, explicit @ context, bounded paging, per-turn deduplication and client tool routing');
