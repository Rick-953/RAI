'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { CHAT_MODEL_IDS } = require('../lib/chat-model-policy');
const source = fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
function section(start,end) { const a=source.indexOf(start),b=source.indexOf(end,a); assert.ok(a>=0&&b>a); return source.slice(a,b); }
async function main(){
    const context={DEEPSEEK_FAST_API_KEY:'test-private-key',KOLORS_IMAGE_MODEL:'test-image',configured:new Set(CHAT_MODEL_IDS),disabled:new Set(),API_PROVIDERS:{},normalizeIncomingModelId:id=>id,getAdminRuntimeSettings:async()=>({fast_default_model:'deepseek-v4.1-flash'}),getDisabledModelSet:async()=>context.disabled,isPublicModelDisabled:async id=>context.disabled.has(id),isRuntimeConfiguredModel:id=>context.configured.has(id)};
    vm.createContext(context);
    vm.runInContext(source.match(/const AUTO_MODEL_PREFERENCE = \[[^;]+;/)[0]+'\n'+section('const MODEL_ROUTING = {','// 创建目录')+'\n'+section('async function resolveVisibleAutoModel()','async function getModelVisibilityPayload')+'\nthis.routes=MODEL_ROUTING;',context);
    for(const id of CHAT_MODEL_IDS){assert.ok(context.routes[id].multimodal,id+' must support vision');assert.equal(context.routes[id].contextWindow,256000);assert.ok(context.routes[id].supportsThinking);for(const candidate of context.getRuntimeFallbackModelIds(id,{requiresMultimodal:true}))assert.ok(CHAT_MODEL_IDS.includes(candidate));}
    assert.equal(context.routes['deepseek-v4.1-flash'].model,'deepseek-v4.1-flash');
    assert.equal(await context.resolveVisibleAutoModel(),'deepseek-v4.1-flash');assert.equal(await context.resolveVisibleThinkingModel(),'deepseek-v4.1-flash');assert.equal(await context.resolveVisionFallbackModel(),'deepseek-v4.1-flash');
    assert.deepEqual(Array.from(context.getRuntimeFallbackModelIds('gpt-6-luna')),['deepseek-v4.1-flash']);
    assert.deepEqual(Array.from(context.getRuntimeFallbackModelIds('gpt-6-astra',{requiresMultimodal:true})),[],'never silently spend a different GPT vision allowance');
    assert.doesNotMatch(source,/音频附件强制路由到 Gemini|不支持多模态，自动切换到/);
    console.log('smart-model-routing PASS: four vision models, exact IDs, 256k windows, no old visual routing, explicit GPT quota isolation');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
