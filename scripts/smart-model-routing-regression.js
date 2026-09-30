'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').replace(/\r\n/g, '\n');
function section(start, end) {
  const a = server.indexOf(start); const b = server.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, 'Missing routing section: ' + start);
  return server.slice(a, b);
}
const routingSource = section('const MODEL_ROUTING = {', '// 创建目录');
const visibleSource = section('async function resolveVisibleAutoModel()', 'async function resolveVisionFallbackModel()');
async function main() {
  const context = {
    normalizeIncomingModelId: value => value,
    configured: new Set(['deepseek-flash', 'deepseek-pro', 'kimi-k2.6']), disabled: new Set(),
    API_PROVIDERS: {},
    KOLORS_IMAGE_MODEL: 'unused-image-fixture',
    getAdminRuntimeSettings: async () => ({smart_default_model:'deepseek-pro',thinking_default_model:'deepseek-pro',fast_default_model:'kimi-k2.6'}),
    getDisabledModelSet: async () => context.disabled,
    isPublicModelDisabled: async model => context.disabled.has(model),
    isRuntimeConfiguredModel: model => context.configured.has(model)
  };
  vm.createContext(context);
  vm.runInContext(server.match(/const AUTO_MODEL_PREFERENCE = \[[^;]+;/)[0] + '\n' + routingSource + '\n' + visibleSource + '\nthis.routes = MODEL_ROUTING;', context);
  assert.equal(context.routes['deepseek-flash'].model, 'deepseek-flash');
  assert.equal(context.routes['deepseek-flash'].thinkingModel, undefined, 'Flash thinking must not secretly use Pro');
  assert.equal(await context.resolveVisibleAutoModel(), 'deepseek-flash', 'legacy Pro admin defaults must not affect Smart');
  assert.equal(await context.resolveVisibleThinkingModel(), 'deepseek-flash', 'thinking must preserve Flash preference');
  assert.equal(await context.resolveVisibleFastModel(), 'kimi-k2.6', 'explicit fast preference remains independent');
  for (const model of Object.keys(context.routes)) {
    const candidates = context.getRuntimeFallbackModelIds(model);
    assert.ok(!candidates.includes('deepseek-pro'), model + ' must not silently fallback to Pro');
    assert.equal(new Set(candidates).size, candidates.length);
    assert.ok(!candidates.includes(model));
    const vision = context.getRuntimeFallbackModelIds(model, {requiresMultimodal:true});
    assert.ok(vision.every(id => context.routes[id].multimodal === true));
  }
  context.disabled.add('deepseek-flash');
  assert.equal(await context.resolveVisibleAutoModel(), 'kimi-k2.6');
  assert.equal(await context.resolveVisibleThinkingModel(), 'kimi-k2.6');
  context.disabled.clear(); context.configured.delete('deepseek-flash');
  assert.equal(await context.resolveVisibleAutoModel(), 'kimi-k2.6');
  console.log('smart-model-routing PASS: Flash default/thinking, stale Pro setting isolation, unavailable/disabled Flash, no silent Pro fallback, multimodal filtering');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
