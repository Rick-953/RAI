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
 const url = 'http://127.0.0.1:' + server.address().port;
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
   const page = await ctx.newPage(); await page.goto(url); await page.waitForFunction(()=>typeof showChatIndexTooltip==='function');
   await page.addStyleTag({content:'*,*::before,*::after{animation:none!important;transition:none!important}'});
   const initial = await page.evaluate(()=>{
    showApp(); appState.handednessEnabled=true; appState.handedness='right'; applyHandednessLayout(); renderWindowsDownloads();
    return {platform:getClientPlatform(),saved:appState.handednessEnabled,effective:document.documentElement.classList.contains('hand-right'),disabled:document.getElementById('settingsHandednessSwitch').disabled,setup:!document.getElementById('windowsSetupRecommended').hidden,pwa:!document.getElementById('pwaInstallRecommended').hidden,models:Array.from(document.querySelectorAll('#modelDropdownMenu [data-model]')).map(x=>x.dataset.model)};
   });
   assert.equal(initial.platform,platform);assert.equal(initial.saved,true);assert.equal(initial.effective,['ios','android'].includes(platform));assert.equal(initial.disabled,!['ios','android'].includes(platform));assert.equal(initial.setup,platform==='windows');assert.equal(initial.pwa,platform!=='windows');
   for(const id of ['deepseek-v4.1-flash','gpt-6.1-sol','gpt-6-luna','gpt-6-astra'])assert.ok(initial.models.includes(id));
   for (const [side,y] of [['right',10],['right',height/2],['right',height-10],['left',height/2]]) {
    const rect = await page.evaluate(({side,y})=>{
     const line=document.createElement('div');line.className='chat-index-line';line.style.cssText='position:fixed;top:'+y+'px;width:24px;height:4px;'+side+':4px;';document.body.append(line);
     showChatIndexTooltip({target:line},'这是一段用于检查右侧问答索引预览边界的长文本。'.repeat(7));
     const r=document.getElementById('chatIndexTooltip').getBoundingClientRect();line.remove();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};
    },{side,y});
    assert.ok(rect.left>=7&&rect.right<=width-7&&rect.top>=7&&rect.bottom<=height-7,JSON.stringify({platform,width,side,y,rect}));
   }
   if(width<=768) {
    for(const [from,to] of [[20,width-20],[width-20,20]]) {
     const gesture = await page.evaluate(({from,to})=>{
      closeSidebar();
      const target=document.querySelector('.chat-container');
      function touch(el,type,x){const event=new Event(type,{bubbles:true,cancelable:true});Object.defineProperty(event,'touches',{value:type==='touchend'?[]:[{clientX:x,clientY:300}]});el.dispatchEvent(event);}
      touch(target,'touchstart',from);touch(target,'touchmove',to);touch(target,'touchend',to);
      const opened=appState.sidebarOpen,side=document.getElementById('sidebar').classList.contains('swipe-from-right');
      const overlay=document.getElementById('mobileOverlay');touch(overlay,'touchstart',from);touch(overlay,'touchmove',to);touch(overlay,'touchend',to);
      return{opened,side,closed:!appState.sidebarOpen};
     },{from,to});
     assert.equal(gesture.opened,true,JSON.stringify(gesture));assert.equal(gesture.side,from>to);assert.equal(gesture.closed,true,JSON.stringify(gesture));
    }
   }
   console.log('model-ui-runtime PASS',platform,width,JSON.stringify(initial));
   await ctx.close();
  }
 } finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
