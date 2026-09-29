'use strict';
// Optional browser smoke: provide Playwright via NODE_PATH, not a production dependency.
// Fully isolated local fixture; never opens a real account or physical camera.
const {chromium}=require('playwright');
const QRCode=require('qrcode');
const assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path'), http=require('node:http');
(async()=>{
 const root=path.resolve(__dirname,'../public');
 const server=http.createServer((req,res)=>{
  try {
   const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
   const file=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
   if(!file.startsWith(root+path.sep)||!fs.statSync(file).isFile()) {res.writeHead(404);res.end();return;}
   const types={'.js':'text/javascript','.html':'text/html','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.webmanifest':'application/manifest+json','.woff2':'font/woff2'};
   res.setHeader('Content-Type',types[path.extname(file)]||'application/octet-stream');fs.createReadStream(file).pipe(res);
  } catch (_) {res.writeHead(404);res.end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port+'/';
 let browser;
 try {browser=await chromium.launch({headless:true,...(process.env.RAI_QR_BROWSER_EXECUTABLE?{executablePath:process.env.RAI_QR_BROWSER_EXECUTABLE}:{})});}
 catch(error) {server.close();throw error;}
 const snapshot=async(page,name)=>{if(process.env.RAI_QR_BROWSER_ARTIFACTS){fs.mkdirSync(process.env.RAI_QR_BROWSER_ARTIFACTS,{recursive:true});await page.screenshot({path:path.join(process.env.RAI_QR_BROWSER_ARTIFACTS,name+'.png')});}};
 try {
  const ctx=await browser.newContext({viewport:{width:1062,height:751},serviceWorkers:'block'}),p=await ctx.newPage();
  const errors=[],requests=[]; p.on('pageerror',e=>errors.push(e.message));
  let auth=false;const token='e30.'+Buffer.from(JSON.stringify({sub:'1',exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.test';
  await p.route('**/api/**',r=>{
    const path=new URL(r.request().url()).pathname;
    if(path.includes('/auth/refresh')) return r.fulfill({status:auth?200:401,contentType:'application/json',body:JSON.stringify(auth?{success:true,token,user:{id:1,username:'Test',email:'test@example.invalid'}}:{error:'not_authenticated'})});
    if(path.endsWith('/chat/stream')) return r.fulfill({status:200,contentType:'text/event-stream',headers:{'X-RAI-Diagnostic-Id':'01234567-89ab-4def-8123-456789abcdef','X-Request-ID':'req_1790650000000_0123456789abcdef'},body:'data: {"type":"model_info","model":"deepseek-flash"}\n\ndata: {"type":"reasoning","content":"PRIVATE-REASONING-CANARY"}\n\ndata: {"type":"content","content":"PRIVATE-CONTENT-CANARY"}\n\ndata: {"type":"done"}\n\n'});
    let body={success:true,models:[],data:[],sessions:[],settings:{},availableModels:[]};
    if(path.endsWith('/qr/claim')) {requests.push('claim');body={id:'A'.repeat(43),approvalSecret:'fixture',device:'Windows / Test',ip:'203.0.113.12',location:'测试地区',code:'123456'};}
    if(path.endsWith('/qr/confirm')) requests.push(JSON.parse(r.request().postData()));
    return r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
  });
  await p.goto(base);await p.locator('#authFooter').waitFor({state:'visible'});
  const geometry=[];
  for(const width of [1280,390,320]) for(const lang of ['zh-CN','zh-TW','en']) {
   await p.setViewportSize({width,height:800});await p.evaluate(l=>setLanguage(l),lang);
   const measured=await p.evaluate(()=>{const a=document.querySelector('#authSwitch').getBoundingClientRect(),b=document.querySelector('#authLangRow').getBoundingClientRect();return {width:innerWidth,lang:appState.language,height:a.height,gap:b.x-a.right,dy:Math.abs(a.y+a.height/2-b.y-b.height/2),overflow:document.documentElement.scrollWidth>innerWidth};});
   assert.equal(measured.overflow,false);assert.equal(measured.height,18);assert.equal(measured.dy,0);assert.ok(measured.gap>=8);geometry.push(measured);
  }
  await snapshot(p,'footer-320');
  auth=true; await p.addInitScript(()=>{Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>{throw new Error('NotAllowedError');}}});});
  await p.setViewportSize({width:1062,height:751}); await p.reload();await p.waitForTimeout(900);
  await p.evaluate(()=>setLanguage('zh-CN')); await p.locator('#qrScanButton').click(); await p.waitForTimeout(500);
  const dialogs=await p.locator('dialog[open]').count();console.log(JSON.stringify({dialogs,errors,status:await p.locator('.rai-scanner-status').allTextContents()},null,2));
  assert.equal(dialogs,1);assert.match(await p.locator('.rai-scanner-status').innerText(),/无法使用相机/);
  const image=await QRCode.toBuffer(base+'qr-login.html#'+'A'.repeat(43)+'.'+'B'.repeat(43));
  await p.locator('dialog input[type=file]').setInputFiles({name:'test-qr.png',mimeType:'image/png',buffer:image});
  await p.getByRole('button',{name:'确认登录',exact:true}).waitFor();assert.deepEqual(requests,['claim']);
  assert.match(await p.locator('dialog[open]').innerText(),/203\.0\.113\.12/);
  await snapshot(p,'confirm-desktop');
  for(const width of [390,320]) {await p.setViewportSize({width,height:700}); const g=await p.locator('dialog[open]').evaluate(e=>({width:e.getBoundingClientRect().width,scroll:e.scrollWidth,client:e.clientWidth}));assert.ok(g.width<=width);assert.ok(g.scroll<=g.client);}
  await snapshot(p,'confirm-mobile');
  await p.getByRole('button',{name:'确认登录',exact:true}).click();await p.waitForTimeout(300);assert.equal(requests[1].approve,true);assert.equal(await p.locator('dialog[open]').count(),0);
  // Real browser MediaStream backed by a canvas: no physical camera or permission grant.
  await p.setViewportSize({width:1062,height:751});
  await p.evaluate(async data=>{
    const img=new Image();img.src=data;await img.decode();
    const c=document.createElement('canvas');c.width=img.width;c.height=img.height;c.getContext('2d').drawImage(img,0,0);
    window.testQrCanvas=c;window.testQrStream=c.captureStream(5);
    navigator.mediaDevices.getUserMedia=async()=>window.testQrStream;
  },'data:image/png;base64,'+image.toString('base64'));
  await p.locator('#qrScanButton').click();await p.getByRole('button',{name:'确认登录',exact:true}).waitFor();
  assert.equal(await p.evaluate(()=>testQrStream.getTracks().every(t=>t.readyState==='ended')),true,'decoded camera stream stopped before confirmation');
  assert.equal(requests.filter(r=>r==='claim').length,2);assert.equal(requests.filter(r=>r.approve===true).length,1,'camera recognition never auto-authorizes');
  await p.getByRole('button',{name:'拒绝',exact:true}).click();await p.waitForTimeout(100);
  await p.evaluate(()=>{navigator.mediaDevices.getUserMedia=()=>new Promise(resolve=>window.resolveLateCamera=resolve);});
  await p.locator('#qrScanButton').click();await p.getByRole('button',{name:'取消',exact:true}).click();
  await p.evaluate(()=>{window.lateStops=0;window.resolveLateCamera({getTracks:()=>[{stop:()=>window.lateStops++}]});});
  await p.waitForTimeout(100);assert.equal(await p.evaluate(()=>window.lateStops),1);assert.equal(await p.locator('dialog[open]').count(),0);
  assert.deepEqual(errors,[]);
  await p.evaluate(async()=>{
    const r=await fetch(API_BASE+'/chat/stream',{method:'POST',body:'PRIVATE-REQUEST-CANARY',headers:{Authorization:'Bearer PRIVATE-TOKEN-CANARY'}});
    const reader=RaiDiagnostics.reader(r);while(!(await reader.read()).done) { /* local fixture bytes only */ }
    openSettings();switchSettingsSection('about');
  });
  const downloadReady=p.waitForEvent('download');
  await p.locator('#exportDiagnosticsButton').click();const download=await downloadReady;
  const exported=fs.readFileSync(await download.path(),'utf8'),report=JSON.parse(exported);
  assert.equal(report.schema,'rai.diagnostics.v1');assert.ok(report.events.length>0);
  for(const canary of ['PRIVATE-REASONING-CANARY','PRIVATE-CONTENT-CANARY','PRIVATE-REQUEST-CANARY','PRIVATE-TOKEN-CANARY','test@example.invalid']) assert.ok(!exported.includes(canary));
  const summary=report.events.find(e=>e.category==='stream'&&e.chatRequestId==='req_1790650000000_0123456789abcdef');
  assert.ok(summary);assert.equal(summary.action,'completed');assert.equal(summary.model,'deepseek-flash');
  assert.equal(summary.serverRequestId,'01234567-89ab-4def-8123-456789abcdef');
  assert.deepEqual(errors,[]);console.log('Diagnostics browser export PASS: real About button downloads valid local-only JSON, safe HTTP/SSE correlation, no request/response/token canaries');
  console.log(JSON.stringify({geometry,scanner:'permission denial, real image decode, device/ip/location, single confirm, desktop/mobile overflow PASS',errors},null,2));
 } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
