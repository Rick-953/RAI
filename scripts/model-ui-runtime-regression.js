'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium, webkit } = require('playwright');
const engine = process.env.RAI_BROWSER_ENGINE === 'webkit' ? webkit : chromium;
const root = path.resolve(__dirname, '../public');
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname.startsWith('/api/')) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'fixture only' }));
    return;
  }
  const file = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!file.startsWith(root + path.sep)) { res.writeHead(404); res.end(); return; }
  const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
  res.setHeader('Content-Type', type[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).on('error', () => { res.writeHead(404); res.end(); }).pipe(res);
});
const browserPath = process.env.RAI_QR_BROWSER_EXECUTABLE;
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) <= 2, `${label}: ${actual} vs ${expected}`);
(async () => {
 await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
 const url = process.env.RAI_UI_BASE_URL || 'http://127.0.0.1:' + server.address().port;
 let browser;
 try {
  browser = await engine.launch({headless:true, ...(browserPath?{executablePath:browserPath}:{})});
  const cases = [
   ['windows',1280,800,'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36'],
   ['windows',500,800,'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36'],
   ['macos',1280,800,'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Version/18 Safari/605.1.15'],
   ['ios',393,852,'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'],
   ['android',412,915,'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36']
  ];
  for (const [platform,width,height,userAgent] of cases) {
   const ctx = await browser.newContext({viewport:{width,height},userAgent,hasTouch:true,serviceWorkers:'block'});
   await ctx.addInitScript(platform => {
    const values={windows:'Win32',macos:'MacIntel',ios:'iPhone',android:'Linux armv8l'};
    Object.defineProperty(navigator,'platform',{get:()=>values[platform],configurable:true});
    Object.defineProperty(navigator,'userAgentData',{get:()=>undefined,configurable:true});
   },platform);
   const page = await ctx.newPage(); await page.goto(url); await page.waitForFunction(()=>typeof showChatIndexTooltip==='function');
   await page.addStyleTag({content:'*,*::before,*::after{animation:none!important;transition:none!important}'});
   const initial = await page.evaluate(()=>{
    showApp(); appState.handednessEnabled=true; appState.handedness='right'; applyHandednessLayout(); renderWindowsDownloads();
    return {platform:getClientPlatform(),saved:appState.handednessEnabled,effective:document.documentElement.classList.contains('hand-right'),disabled:document.getElementById('settingsHandednessSwitch').disabled,setup:!document.getElementById('windowsSetupRecommended').hidden,pwa:!document.getElementById('pwaInstallRecommended').hidden,models:Array.from(document.querySelectorAll('#modelDropdownMenu [data-model]')).map(x=>x.dataset.model)};
   });
   assert.equal(initial.platform,platform);assert.equal(initial.saved,true);assert.equal(initial.effective,['ios','android'].includes(platform));assert.equal(initial.disabled,!['ios','android'].includes(platform));assert.equal(initial.setup,platform==='windows');assert.equal(initial.pwa,platform!=='windows');
   for(const id of ['deepseek-v4.1-flash','gpt-6.1-sol','gpt-6-luna','gpt-6-astra'])assert.ok(initial.models.includes(id));
   const provenance=await page.evaluate(()=>{
    appState.showModelBadge=true;
    return ['gpt-6.1-sol','deepseek-flash','gpt-6-luna'].map(id=>{
     const msg=createMessageElement({role:'assistant',content:'fixture',model:id});
     return msg.querySelector('.model-meta-badge').textContent.trim();
    });
   });
   assert.deepEqual(provenance,['gpt-6.1-sol','deepseek-flash','gpt-6-luna']);
   // Use parsed DOM and measured geometry: text checks cannot catch an extra closing div.
   for (const hand of ['left','right']) {
    const layout = await page.evaluate(hand => {
     appState.handedness=hand; applyHandednessLayout();
     const send=document.getElementById('sendBtn'), stop=document.getElementById('stopBtn');
     const toolbar=document.querySelector('.input-toolbar');
     const rect=el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
     const sr=rect(send), tr=rect(toolbar);
     send.style.display='none';stop.style.display='flex';const rr=rect(stop);
     stop.style.display='none';send.style.display='flex';
     return {sendParent:send.parentElement===toolbar,stopParent:stop.parentElement===toolbar,send:sr,stop:rr,toolbar:tr};
    },hand);
    assert.equal(layout.sendParent,true,JSON.stringify(layout));assert.equal(layout.stopParent,true);
    near(layout.send.right,layout.toolbar.right,'send right edge');near(layout.stop.right,layout.toolbar.right,'stop right edge');
    assert.ok(layout.send.top>=layout.toolbar.top-1&&layout.send.bottom<=layout.toolbar.bottom+1,JSON.stringify(layout));
   }
   for (const [lang,smartName] of [['zh-CN','智能模型'],['zh-TW','智慧模型'],['en','Smart Model']]) {
    const names=await page.evaluate(lang=>{setLanguage(lang);return Array.from(document.querySelectorAll('[data-i18n="model-smart"]')).map(el=>el.textContent.trim());},lang);
    for(const name of names)assert.equal(name,smartName);
    await page.evaluate(()=>{openSettings();switchSettingsSection('app',{pushHistory:false});renderWindowsDownloads();});
    await page.waitForTimeout(380);
    const badges=await page.evaluate(()=>{
     const badge=document.getElementById('windowsSetupRecommended'),link=document.getElementById('windowsSetupDownload'),pwa=document.getElementById('pwaInstallRecommended');
     const rect=el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
     return{nested:badge.parentElement===link,hidden:badge.hidden,pwaHidden:pwa.hidden,badge:rect(badge),button:rect(link),pwa:rect(pwa),pwaTitle:rect(document.getElementById('settingsPwaDownloadTitle')),text:link.textContent,rows:document.querySelector('.settings-windows-actions').children.length};
    });
    assert.equal(badges.nested,true);assert.equal(badges.rows,2);assert.equal(badges.hidden,platform!=='windows');assert.equal(badges.pwaHidden,platform==='windows');
    if(platform==='windows'){
     assert.ok(badges.badge.width>10&&badges.badge.width<100,JSON.stringify(badges));
     assert.ok(badges.badge.left>=badges.button.left&&badges.badge.right<=badges.button.right,JSON.stringify(badges));
     near((badges.badge.top+badges.badge.bottom)/2,(badges.button.top+badges.button.bottom)/2,'badge vertical alignment');
    } else {assert.ok(badges.pwa.width>10&&badges.pwa.width<100,JSON.stringify(badges));near((badges.pwa.top+badges.pwa.bottom)/2,(badges.pwaTitle.top+badges.pwaTitle.bottom)/2,'PWA badge alignment');}
    if(process.env.RAI_UI_SCREENSHOTS&&lang==='zh-CN'){
     const out=path.resolve(process.env.RAI_UI_SCREENSHOTS);fs.mkdirSync(out,{recursive:true});
     await page.locator('#settingsInstallCard').screenshot({path:path.join(out,platform+'-'+width+'-downloads.png')});
    }
    await page.evaluate(()=>closeSettings());
    await page.waitForTimeout(380);
   }
   if(process.env.RAI_UI_SCREENSHOTS){const out=path.resolve(process.env.RAI_UI_SCREENSHOTS);fs.mkdirSync(out,{recursive:true});await page.locator('.input-container').screenshot({path:path.join(out,platform+'-'+width+'-composer.png')});}
   for (const [side,y] of [['right',10],['right',height/2],['right',height-10],['left',height/2]]) {
    const rect = await page.evaluate(({side,y})=>{
     const line=document.createElement('div');line.className='chat-index-line';line.style.cssText='position:fixed;top:'+y+'px;width:24px;height:4px;'+side+':4px;';document.body.append(line);
     showChatIndexTooltip({target:line},'这是一段用于检查右侧问答索引预览边界的长文本。'.repeat(7));
     const r=document.getElementById('chatIndexTooltip').getBoundingClientRect();line.remove();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};
    },{side,y});
    assert.ok(rect.left>=7&&rect.right<=width-7&&rect.top>=7&&rect.bottom<=height-7,JSON.stringify({platform,width,side,y,rect}));
   }
   if(width<=768) {
    for(const closeTarget of ['sidebar','overlay']) for(const [from,to] of [[20,width-20],[width-20,20]]) {
     const gesture = await page.evaluate(({from,to,closeTarget})=>{
      closeSidebar();
      const target=document.querySelector('.chat-container');
      function touch(el,type,x){const event=new Event(type,{bubbles:true,cancelable:true});Object.defineProperty(event,'touches',{value:type==='touchend'?[]:[{clientX:x,clientY:300}]});el.dispatchEvent(event);}
      touch(target,'touchstart',from);touch(target,'touchmove',to);touch(target,'touchend',to);
      const opened=appState.sidebarOpen,side=document.getElementById('sidebar').classList.contains('swipe-from-right');
      const closeEl=closeTarget==='sidebar'?document.querySelector('#sidebar .sidebar-scrollable'):document.getElementById('mobileOverlay');touch(closeEl,'touchstart',to);touch(closeEl,'touchmove',from);touch(closeEl,'touchend',from);
      return{opened,side,closed:!appState.sidebarOpen};
     },{from,to,closeTarget});
     assert.equal(gesture.opened,true,JSON.stringify(gesture));assert.equal(gesture.side,from>to);assert.equal(gesture.closed,true,JSON.stringify(gesture));
    }
   }
   if(width<=768&&process.env.RAI_BROWSER_ENGINE!=='webkit'){
    const cdp=await ctx.newCDPSession(page);
    async function touch(type,x,y){await cdp.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'?[]:[{x,y}],modifiers:0});}
    for(const right of [false,true]){
     await page.evaluate(right=>{document.getElementById('sidebar').classList.toggle('swipe-from-right',right);openSidebar();},right);
     const bounds=await page.locator('#sidebar').boundingBox();
     const start=right?bounds.x+40:bounds.x+bounds.width-40,y=300,end=right?start+240:start-240;
     await touch('touchStart',start,y);
     for(let step=1;step<=8;step++){await touch('touchMove',start+(end-start)*step/8,y);await page.waitForTimeout(16);}
     await touch('touchEnd',end,y);
     assert.equal(await page.evaluate(()=>appState.sidebarOpen),false,'real reverse swipe inside '+(right?'right':'left')+' sidebar');
     await page.waitForTimeout(100);
    }
    await cdp.detach();
   }
   console.log('model-ui-runtime PASS',platform,width,JSON.stringify(initial));
   await ctx.close();
  }
 } finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
