'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const agent = require('../lib/cx-agent-tools');
const skills = require('../lib/client-skill-policy');
const context = { protocol: 1, catalog: [], selected: [] };
assert.equal(agent.definitions.length, 4);
const revision = Buffer.alloc(32).toString('base64');
assert.deepEqual(agent.normalizeArgs('read_code', { path: 'src/main.cs', offset: 10, limit: 20 }), { path: 'src/main.cs', offset: 10, limit: 20 });
assert.deepEqual(agent.normalizeArgs('edit_code', { path: 'src/main.cs', revision, old_text: 'old', new_text: '' }), { path: 'src/main.cs', revision, old_text: 'old', new_text: '' });
for (const path of ['../secret', '/secret', 'C:\\secret', 'src/../secret', 'file:stream', 'src//file', 'src/./file'])
    assert.equal(agent.normalizeArgs('read_code', { path }), null, path);
for (const limit of [-1, 0, 1001, Infinity, '200']) assert.equal(agent.normalizeArgs('read_code', { path: 'main.cs', limit }), null);
assert.equal(agent.normalizeArgs('edit_code', { path: 'main.cs', old_text: 'old', new_text: 'new' }), null);
assert.equal(agent.normalizeArgs('search_code', { pattern: '' }), null);
assert.equal(agent.normalizeArgs('search_code', { pattern: 'foo', unexpected: true }), null);
assert.ok(skills.configureTools([], context, true).some(tool => tool.function.name === 'enable_agent_mode'), 'Chat exposes Agent activation');
assert.ok(!skills.configureTools([], context).some(tool => tool.function.name === 'enable_agent_mode'), 'Older clients do not receive unsupported activation');
assert.equal(skills.normalizeAgentActivation({ success: true, agent_mode: true, client_skills: context }).agent_mode, true);
assert.equal(skills.normalizeAgentActivation({ success: false, error: 'user_denied' }).error, 'user_denied');
assert.throws(() => skills.normalizeAgentActivation({ success: true, agent_mode: false, client_skills: context }));
assert.throws(() => skills.normalizeAgentActivation({ success: true, agent_mode: true }));
const server = fs.readFileSync(require.resolve('../server'), 'utf8');
for (const contract of ['cxAgentEnabled: cxAgentAvailable', 'clientSkills, cxAgentAvailable', 'cxAgentTools.normalizeArgs(toolName, args)',
    "pending.toolName === 'enable_agent_mode'", "'revision', 'content', 'total_lines', 'next_line'"])
    assert.ok(server.includes(contract), 'Missing production wiring: ' + contract);
console.log('PASS: Agent code contracts, traversal/argument rejection, Chat activation capability and permission-failure normalization');
