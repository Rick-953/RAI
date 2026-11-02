'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../public');
const requests = [];
const sol = { id: 'gpt-6.1-sol', name: 'GPT 6.1 Sol', enabled: true, builtin: true, provider: 'rai_gpt_gateway',
  supportsThinking: true, canDisableThinking: false, thinkingProfiles: ['auto','low','medium','high','xhigh','max'], vision: true };
const ds = { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', enabled: true, builtin: true, provider: 'deepseek',
  supportsThinking: true, canDisableThinking: true, thinkingProfiles: ['auto','high','max'], vision: true };
const luna = { id: 'gpt-6-luna', name: 'GPT 6 Luna', enabled: true, builtin: true, provider: 'rai_luna_gateway',
  supportsThinking: true, canDisableThinking: true, thinkingProfiles: ['auto','low','medium','high','xhigh','max'], vision: true };
let models = [sol, ds, luna];
let settings = { smart_default_model: sol.id, smart_reasoning_profile: 'low', fast_default_model: ds.id,
  fast_reasoning_profile: 'none', thinking_default_model: sol.id, thinking_reasoning_profile: 'auto',
  selection_explanation_model: ds.id, concurrent_requests_free: 2, concurrent_requests_pro_max: 5, upload_max_file_mb: 50 };
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (url.pathname.startsWith('/api/')) {
    let body=''; for await (const chunk of request) body += chunk;
    const data = body ? JSON.parse(body) : {};
    const record = { path:url.pathname, method:request.method, body:data, admin:request.headers['x-admin-token'], user:request.headers.authorization };
    requests.push(record);
    const reply = (status, value) => { response.writeHead(status, {'Content-Type':'application/json'}); response.end(JSON.stringify(value)); };
    if (url.pathname === '/api/model-availability') return reply(200, { models, disabledModels:models.filter(model=>!model.enabled).map(model=>model.id),
      smartDefaults:{model:sol.id,reasoningProfile:settings.smart_reasoning_profile,thinkingMode:true},
      fastDefaults:{model:ds.id,reasoningProfile:'none',thinkingMode:false} });
    if (url.pathname.startsWith('/api/admin/')) {
      assert.equal(record.admin, 'isolated-admin-fixture', 'admin requests retain separate admin token');
      assert.equal(record.user, undefined, 'user bearer must not replace admin auth');
      if (url.pathname === '/api/admin/models' && request.method === 'GET') return reply(200,{models});
      if (url.pathname === '/api/admin/models' && request.method === 'POST') { models.push({...data,builtin:false});return reply(200,{success:true}); }
      if (url.pathname.startsWith('/api/admin/models/')) {
        const id=decodeURIComponent(url.pathname.split('/').pop());
        if(request.method==='DELETE')models=models.filter(model=>model.id!==id);
        if(request.method==='PUT')models.find(model=>model.id===id).enabled=data.enabled;
        return reply(200,{success:true});
      }
      if(url.pathname==='/api/admin/runtime-settings'){
        if(request.method==='PUT')settings={...settings,...data};
        return reply(200,{settings});
      }
    }
    return reply(401,{error:'isolated UI fixture'});
  }
  const filename = path.resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
  if (!filename.startsWith(root + path.sep)) {response.writeHead(404);response.end();return;}
  response.setHeader('Content-Type', ({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.json':'application/json'})[path.extname(filename)] || 'application/octet-stream');
  fs.createReadStream(filename).on('error',()=>{response.writeHead(404);response.end();}).pipe(response);
});

const tableSamples = [
  '| 证书 | 成本 | 周期 | 适合 |\n---|---|---|\n AWS Cloud Practitioner | ~$100 USD | 2-4 周 | 云基础入门，最便宜的敲门砖 |\n Google Data Analytics / IT Support（Coursera） | 订阅费 | 1-2 个月 | 简历上好看，内容偏浅 |\n Microsoft AZ-900 / AI-900 | ~$99 USD | 1-2 周 | 比 AWS 更简单的入门级 |',
  '| 形态 | 上下文关系 | 典型实现 | ---|---| 同时与两个 agent 对话（多开窗口） | 完全独立，互不可见 | 你手动开两个 chat，各说各的 | 多 agent 系统（orchestrator 模式） | 各自有独立上下文，但由调度层中转信息 | Planner 拆任务 → Coder 执行 → Reviewer 审 | 多 agent 共享上下文（群聊模式） | 同一个消息流，所有 agent 都能看到全部历史 | AutoGen GroupChat、CrewAI 的 shared memory |',
  '| 类型 | 命中条件 | 多 agent 的影响 | ---|---| Prompt Cache（模型侧，如 Anthropic/OpenAI 的 context caching） | 请求前缀逐字节完全一致 | 每个 agent 系统提示不同 → 各自独立前缀，跨 agent 无法共享 | KV Cache / 本地推理缓存 | 序列前缀一致 | 同上，且显存/内存压力翻倍 | 代码/构建缓存（vibe coding 场景） | 文件内容 hash | agent 并行改同一文件 → 频繁失效 |'
];

(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 let browser;
 try {
  browser=await chromium.launch({headless:true,...(process.env.RAI_QR_BROWSER_EXECUTABLE?{executablePath:process.env.RAI_QR_BROWSER_EXECUTABLE}:{})});
  const context=await browser.newContext({viewport:{width:1280,height:900},serviceWorkers:'block'});
  const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>typeof renderMarkdownWithMath==='function');
  const openAllModels=async()=>{
   await page.locator('#modelSelectCustom').click();
   const toggle=page.locator('#modelDropdownMenu [data-toggle="all-models"]');
   if(await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();
   await page.waitForFunction(()=>document.querySelector('#allModelsSection')?.classList.contains('expanded'));
  };
  await page.evaluate(async()=>{showApp();await fetchModelAvailability();updateToolbarUI();});
  const rendered=await page.evaluate(samples=>{
   const host=document.createElement('div');host.id='tableAudit';host.className='message-text';
   host.innerHTML=renderMarkdownWithMath(samples.join('\n\n'));document.getElementById('messagesList').append(host);
   const code='```text\n| A | B | C | ---|---| one | two | three |\n```';
   const codeHost=document.createElement('div');codeHost.innerHTML=renderMarkdownWithMath(code);
   const escaped=document.createElement('div');escaped.innerHTML=renderMarkdownWithMath('| A | B |\n| --- | --- |\n| a\\|b | `x|y` |');
   return {tables:host.querySelectorAll('table').length,columns:Array.from(host.querySelectorAll('table')).map(t=>t.querySelectorAll('thead th').length),
    rows:Array.from(host.querySelectorAll('table')).map(t=>t.querySelectorAll('tbody tr').length),codeTables:codeHost.querySelectorAll('table').length,
    codeText:codeHost.textContent,escapedCells:Array.from(escaped.querySelectorAll('tbody td')).map(td=>td.textContent)};
  },tableSamples);
  assert.equal(rendered.tables,3);assert.deepEqual(rendered.columns,[4,3,3]);assert.deepEqual(rendered.rows,[3,3,3]);assert.equal(rendered.codeTables,0);assert.ok(rendered.codeText.includes('| ---|---|'));assert.deepEqual(rendered.escapedCells,['a|b','x|y']);
  assert.equal(await page.locator('#modelDropdownMenu [data-mode="fast"],#modelDropdownMenu [data-mode="think"]').count(),0);
  assert.deepEqual(await page.evaluate(()=>({model:appState.selectedModel,profile:getRequestReasoningProfileForCurrentMode()})),
    {model:'auto',profile:'low'},'Smart retains its low request profile instead of forcing max');
  await page.locator('#moreBtn').click();await page.locator('.reasoning-profile-header').click();
  assert.deepEqual(await page.evaluate(()=>({thinking:appState.thinkingMode,profile:getRequestReasoningProfileForCurrentMode()})),
    {thinking:false,profile:'none'},'Smart can switch to the configured fast output model');
  await page.locator('.reasoning-profile-header').click();
  assert.deepEqual(await page.evaluate(()=>({thinking:appState.thinkingMode,profile:getRequestReasoningProfileForCurrentMode()})),
    {thinking:true,profile:'auto'},'Enabling Smart thinking uses Adaptive');
  await page.locator('#moreBtn').click();
  await openAllModels();await page.locator('#allModelsSection [data-model="gpt-6.1-sol"]').first().click();
  await page.locator('#moreBtn').click();await page.locator('.reasoning-profile-header').hover();
  await page.locator('.reasoning-profile-header').click();
  assert.equal(await page.evaluate(()=>appState.thinkingMode),true);
  assert.match(await page.locator('body').innerText(),/不支持关闭思考|requires thinking/);
  await page.locator('#reasoningProfileChoices [data-profile="high"]').click();
  assert.deepEqual(await page.evaluate(()=>({profile:appState.reasoningProfile,thinking:appState.thinkingMode})),{profile:'high',thinking:true});
  await page.reload();await page.waitForFunction(()=>typeof resetModelToSmart==='function');
  assert.deepEqual(await page.evaluate(()=>{showApp();resetModelToSmart();return{model:appState.selectedModel,profile:appState.reasoningProfile};}),{model:sol.id,profile:'high'});
  await page.locator('#moreBtn').click();await page.locator('.reasoning-profile-header').click();
  await page.locator('#reasoningProfileChoices [data-profile="low"]').click();
  await page.locator('#moreBtn').click();
  await openAllModels();
  await page.locator('#allModelsSection [data-model="deepseek-v4.1-flash"]').first().click();
  assert.deepEqual(await page.evaluate(()=>({profile:appState.reasoningProfile,stored:JSON.parse(localStorage.getItem(modelPreferenceStorageKey())).reasoningProfile,
    supported:currentThinkingCapability().profiles,request:getRequestReasoningProfileForCurrentMode()})),
    {profile:'auto',stored:'auto',supported:['auto','high','max'],request:'auto'},
    'Sol Low becomes a valid DeepSeek Auto preference for UI, persistence and request configuration');
  await page.locator('#moreBtn').click();await page.locator('.reasoning-profile-header').click();
  assert.deepEqual(await page.locator('#reasoningProfileChoices button').evaluateAll(buttons=>buttons.map(button=>button.dataset.profile)),['auto','high','max']);
  await page.locator('#reasoningProfileChoices [data-profile="high"]').click();
  await page.locator('#moreBtn').click();
  await openAllModels();
  await page.locator('#allModelsSection [data-model="gpt-6.1-sol"]').first().click();
  assert.deepEqual(await page.evaluate(()=>({model:appState.selectedModel,profile:appState.reasoningProfile,
    stored:JSON.parse(localStorage.getItem(modelPreferenceStorageKey())).reasoningProfile})),
    {model:sol.id,profile:'high',stored:'high'},'valid DeepSeek High preference survives switching to Sol');
  await openAllModels();
  await page.locator('#allModelsSection [data-model="deepseek-v4.1-flash"]').first().click();
  assert.equal(await page.evaluate(()=>appState.reasoningProfile),'high','valid High preference survives switching back to DeepSeek');
  await page.locator('#moreBtn').click();await page.locator('.reasoning-profile-header').click();
  await page.locator('#reasoningProfileChoices [data-profile="max"]').click();
  await page.reload();await page.waitForFunction(()=>typeof resetModelToSmart==='function');
  assert.deepEqual(await page.evaluate(()=>{showApp();resetModelToSmart();return{model:appState.selectedModel,profile:appState.reasoningProfile};}),{model:ds.id,profile:'max'});
  await openAllModels();await page.locator('#allModelsSection [data-model="gpt-6-luna"]').first().click();
  await page.locator('#moreBtn').click();await page.locator('.reasoning-profile-header').click();
  assert.deepEqual(await page.evaluate(()=>({model:getRequestModelIdForCurrentMode(),thinking:appState.thinkingMode,profile:getRequestReasoningProfileForCurrentMode()})),
    {model:luna.id,thinking:false,profile:'none'},'Luna retains its dedicated canonical ID and supports thinking off');
  await page.locator('#moreBtn').click();
  const attachments=await page.evaluate(()=>{
   let previewCount=0;const original=previewAttachment;window.previewAttachment=()=>previewCount++;
   const message=createMessageElement({role:'user',content:'mixed files',attachments:[{type:'image',fileName:'preview.png',data:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6RmcAAAAASUVORK5CYII='},{type:'document',fileName:'长文件名'.repeat(20)+'.pdf'}]});
   document.getElementById('messagesList').append(message);message.querySelector('.image-attachment img').click();window.previewAttachment=original;
   return{above:message.querySelector('.message-content').firstElementChild.classList.contains('message-attachments'),previewCount,title:message.querySelector('.media-name').title,count:message.querySelectorAll('.message-attachment-item').length};
  });
  assert.equal(attachments.above,true);assert.equal(attachments.previewCount,1);assert.equal(attachments.count,2);assert.ok(attachments.title.endsWith('.pdf'));
  let dialog='';page.once('dialog',async item=>{dialog=item.message();await item.accept();});
  assert.equal(await page.evaluate(()=>processUploadedFile(new File(['test'],'乱'.repeat(256)+'.txt',{type:'text/plain'}))),false);
  assert.match(dialog,/重命名|Rename/);
  await page.evaluate(async()=>{
   appState.token='isolated-user-fixture';adminState.token='isolated-admin-fixture';
   for(const id of ['adminModelsPanel','adminLimitsPanel']){const panel=document.createElement('div');panel.id=id;document.body.append(panel);}
   await loadAdminModels();await loadAdminLimits();
  });
  await page.locator('#adminModelCreateForm [name="id"]').fill('fixture-sol');await page.locator('#adminModelCreateForm [name="name"]').fill('Fixture Sol');
  await page.locator('#adminModelCreateForm [type="submit"]').click();
  await page.waitForFunction(()=>document.getElementById('adminModelsPanel').textContent.includes('Fixture Sol')&&!document.querySelector('#adminModelCreateForm [type="submit"]').disabled);
  assert.ok(models.some(model=>model.id==='fixture-sol'));
  await page.locator('#adminLimitsPanel [data-admin-limit="smart_reasoning_profile"]').selectOption('high');
  await page.locator('#adminLimitsPanel [data-rai-click="saveAdminLimits()"]').click();
  await page.waitForFunction(()=>document.querySelector('#adminLimitsPanel [data-admin-limit="smart_reasoning_profile"]')?.value==='high');
  assert.equal(settings.smart_reasoning_profile,'high');
  page.once('dialog',dialog=>dialog.accept());
  await page.locator('[data-admin-model-delete]').click();await page.waitForFunction(()=>!document.getElementById('adminModelsPanel').textContent.includes('Fixture Sol'));
  assert.equal(models.some(model=>model.id==='fixture-sol'),false);
  assert.ok(requests.some(request=>request.method==='POST'&&request.path==='/api/admin/models'));
  assert.ok(requests.some(request=>request.method==='DELETE'&&request.path==='/api/admin/models/fixture-sol'));
  assert.deepEqual(errors,[]);
  const shots=process.env.RAI_UI_SCREENSHOTS;
  if(shots){fs.mkdirSync(shots,{recursive:true});await page.screenshot({path:path.join(shots,'web-ui-completion-admin.png'),fullPage:true});}
  console.log('web-ui-completion PASS: 3 malformed tables; code/escaped pipes; model/reasoning persistence; Sol off feedback; mixed attachments; filename dialog; isolated admin CRUD/settings');
  await context.close();
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
