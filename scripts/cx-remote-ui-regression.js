'use strict';
const assert=require('node:assert/strict'),path=require('node:path'),crypto=require('node:crypto');
const {chromium,webkit}=require('playwright');
(async()=>{
 const engine=process.env.RAI_BROWSER_ENGINE==='webkit'?webkit:chromium;
 const browser=await engine.launch({headless:true,...(process.env.RAI_QR_BROWSER_EXECUTABLE?{executablePath:process.env.RAI_QR_BROWSER_EXECUTABLE}:{})});
 try{for(const viewport of [{width:393,height:852},{width:1440,height:900}]){
  const page=await browser.newPage({viewport});const requests=[];let reject=false;
  const token=crypto.randomBytes(32).toString('hex');let session={id:'test-session',conversationId:'chat-1',status:'pending',expiresAt:Date.now()+900000,confirmationCode:'A1B2C3'};
  await page.route('https://cx-fixture.test/api/cx-remote/**',async route=>{
   const req=route.request();requests.push({url:req.url(),method:req.method(),actor:req.headers().authorization});let data={success:true};
   if(req.url().endsWith('/devices'))data.devices=[{id:'test-pc',name:'<img src=x onerror=alert(1)>',version:'1.8.7',online:true}];
   if(req.url().endsWith('/sessions')&&req.method()==='POST'){session={...session,status:'pending'};data.session=session;}
   if(req.url().endsWith('/sessions/test-session')&&req.method()==='GET'){if(reject){await route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({success:false,error:'rejected'})});return;}data.session={...session,status:'approved'};}
   await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
  });
  await page.route('https://cx-fixture.test/',route=>route.fulfill({contentType:'text/html',body:'<html><body><button id="localAgentMenuItem">Connect</button><span id="localAgentToggle"></span><div id="settingsLocalAgentCard"></div></body></html>'}));
  await page.goto('https://cx-fixture.test/');
  await page.evaluate(t=>{window.fixtureContext={token:t,conversationId:'chat-1',language:'zh'};window.getRaiLocalAgentContext=()=>({...window.fixtureContext});window.openSettings=()=>{window.opened=true;};window.switchSettingsSection=x=>{window.section=x;};},token);
  await page.addStyleTag({path:path.resolve(__dirname,'../public/local-agent.css')});
  await page.addScriptTag({path:path.resolve(__dirname,'../public/cx-remote.js')});
  await page.waitForFunction(()=>document.querySelector('#settingsLocalAgentCard').textContent.includes('1.8.7'));
  assert.equal(await page.locator('#settingsLocalAgentCard img').count(),0,'device metadata rendered as text');
  await page.click('#localAgentMenuItem');assert.equal(await page.evaluate(()=>window.section),'capabilities');
  await page.evaluate(()=>window.RaiLocalAgent.enable('test-pc'));
  assert.equal((await page.evaluate(()=>window.RaiLocalAgent.getChatCapability())).protocolVersion,'cx-online-v1');
  assert.ok((await page.locator('#settingsLocalAgentCard').textContent()).includes('A1B2C3'));
  await page.evaluate(()=>{window.fixtureContext.conversationId='chat-2';});assert.equal(await page.evaluate(()=>window.RaiLocalAgent.getChatCapability()),null);
  await page.evaluate(()=>window.RaiLocalAgent.disable());assert.ok(requests.some(r=>r.method==='DELETE'&&r.actor==='Bearer '+token));
  reject=true;await page.evaluate(()=>window.RaiLocalAgent.enable('test-pc').catch(()=>{}));assert.equal(await page.evaluate(()=>window.RaiLocalAgent.getChatCapability()),null);reject=false;
  await page.evaluate(()=>{window.fixtureContext.conversationId='chat-1';});await page.evaluate(()=>window.RaiLocalAgent.enable('test-pc'));
  await page.evaluate(()=>{window.fixtureContext.token='other-actor';});assert.equal(await page.evaluate(()=>window.RaiLocalAgent.getChatCapability()),null);
  await page.evaluate(()=>window.RaiLocalAgent.refreshStatus());assert.equal(await page.evaluate(()=>window.RaiLocalAgent.getChatCapability()),null);
  await page.close();
 }
 console.log('cx-remote-ui PASS: phone/desktop connect, real setting section, safe text, code, approval/denial, conversation/account isolation, revoke old actor');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
