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
    res.end('{}'); return;
  }
  const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(root + path.sep)) { res.writeHead(404); res.end(); return; }
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
  res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).on('error', () => { res.writeHead(404); res.end(); }).pipe(res);
});
const cases = [
  { platform: 'windows', width: 1280, height: 800, ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36' },
  { platform: 'macos', width: 1280, height: 800, ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Version/18 Safari/605.1.15' },
  { platform: 'android', width: 412, height: 915, ua: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36' },
  { platform: 'ios', width: 393, height: 852, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1' },
  { platform: 'ios', width: 393, height: 852, standalone: true, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1' }
];
async function testCase(browser, url, fixture) {
  const mobile = fixture.width <= 768;
  const ctx = await browser.newContext({ viewport: { width: fixture.width, height: fixture.height }, userAgent: fixture.ua, hasTouch: mobile, serviceWorkers: 'block' });
  try {
    await ctx.addInitScript(({ platform, standalone }) => {
      const platforms = { windows: 'Win32', macos: 'MacIntel', android: 'Linux armv8l', ios: 'iPhone' };
      Object.defineProperty(navigator, 'platform', { get: () => platforms[platform], configurable: true });
      Object.defineProperty(navigator, 'userAgentData', { get: () => undefined, configurable: true });
      if (standalone) Object.defineProperty(navigator, 'standalone', { get: () => true, configurable: true });
    }, fixture);
    const page = await ctx.newPage();
    // No account, provider request or paid model is involved, even against live assets.
    const chatCalls = [];
    await page.route('**/api/**', route => {
      if (/\/chat(?:\/|\?|$)/.test(new URL(route.request().url()).pathname)) chatCalls.push(route.request().url());
      return route.fulfill({ status: 401, contentType: 'application/json', body: '{}' });
    });
    await page.goto(url);
    await page.waitForFunction(() => typeof handleInputContainerClick === 'function' && document.documentElement.dataset.raiAuthState === 'anonymous');
    await page.evaluate(() => { showApp(); document.getElementById('messageInput').blur(); });
    await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' });
    const input = page.locator('#messageInput');
    let checked = 0;
    for (const theme of ['light', 'dark']) {
      for (const hand of ['left', 'right']) {
        await page.evaluate(({ theme, hand }) => {
          document.documentElement.setAttribute('data-theme', theme);
          appState.handednessEnabled = true; appState.handedness = hand; applyHandednessLayout();
          document.getElementById('messageInput').value = '';
          autoResizeInput();
        }, { theme, hand });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const points = await page.evaluate(mobile => {
          const container = document.getElementById('inputContainer');
          const rect = container.getBoundingClientRect();
          const candidates = [];
          // Surface padding, the input row and button-to-button gaps are hit-tested.
          for (const y of [rect.top + 12, rect.top + rect.height / 2, rect.bottom - 12]) {
            for (const fraction of [0.03, 0.15, 0.25, 0.35, 0.5, 0.65, 0.75, 0.85, 0.97]) candidates.push({ x: rect.left + rect.width * fraction, y });
          }
          const model = container.querySelector('.model-selector');
          if (model?.getBoundingClientRect().width) {
            const r = model.getBoundingClientRect();
            candidates.push({ x: r.left + r.width / 2, y: r.bottom - 1 });
          }
          const interactive = 'button, a, input, textarea, select, [role="button"], [role="menuitem"], [role="slider"], [data-rai-click], .more-menu, .model-dropdown-menu';
          // Mobile engines deliberately snap touches near buttons to those controls.
          // Keep touch fixtures outside that native hit-slop, while mouse tests cover all gaps.
          const controls = mobile ? Array.from(container.querySelectorAll('button,[role="button"]')).map(el => el.getBoundingClientRect()).filter(r => r.width && r.height) : [];
          return candidates.map(point => ({ ...point, target: document.elementFromPoint(point.x, point.y) })).filter(point => point.target && container.contains(point.target) && !point.target.closest(interactive) && !controls.some(r => point.x >= r.left - 24 && point.x <= r.right + 24 && point.y >= r.top - 24 && point.y <= r.bottom + 24)).map(({ x, y, target }) => ({ x, y, target: target.className }));
        }, mobile);
        assert.ok(points.length >= 5, JSON.stringify({ fixture, theme, hand, points }));
        for (const point of points) {
          await page.evaluate(() => document.getElementById('messageInput').blur());
          if (mobile) {
            await page.touchscreen.tap(point.x, point.y);
          } else {
            await page.mouse.move(point.x, point.y);
            await page.mouse.down();
            assert.equal(await input.evaluate(el => document.activeElement === el), true, 'focus within pointer gesture: ' + JSON.stringify(point));
            await page.mouse.up();
          }
          assert.equal(await input.evaluate(el => document.activeElement === el), true, 'blank hit: ' + JSON.stringify({ fixture, theme, hand, point }));
          await page.keyboard.insertText('输入');
          assert.ok((await input.inputValue()).endsWith('输入'));
          checked++;
        }
      }
    }
    // Maximum reasoning must survive normalization, native dragging and locale switches.
    await page.evaluate(() => {
      appState.handednessEnabled = false; applyHandednessLayout();
      appState.selectedModel = 'gpt-6.1-sol'; appState.thinkingMode = false;
      setReasoningProfile('max'); toggleThinkingFromMenu({stopPropagation(){}});
    });
    await page.locator('#moreBtn').click();
    const slider = page.locator('#reasoningProfileSlider');
    await slider.waitFor({ state: 'visible' });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(() => appState.reasoningProfile), 'auto');
    assert.equal(await slider.inputValue(), '0');
    for (let level = 0; level <= 4; level++) {
      await page.evaluate(() => setReasoningProfile('auto'));
      const r = await slider.boundingBox();
      const start = r.x + 7, end = start + (r.width - 14) * level / 4, y = r.y + r.height / 2;
      await page.mouse.move(start, y); await page.mouse.down();
      await page.mouse.move(end, y, { steps: 12 }); await page.mouse.up();
      const state = await page.evaluate(() => ({ value: document.getElementById('reasoningProfileSlider').value, profile: appState.reasoningProfile, progress: document.getElementById('reasoningProfileSlider').style.getPropertyValue('--slider-progress') }));
      assert.equal(state.value, String(level), JSON.stringify({ fixture, level, state }));
      assert.equal(state.profile, ['auto', 'low', 'medium', 'high', 'max'][level]);
      if (level === 4) assert.equal(state.progress, '100%');
    }
    if (mobile && engine === chromium) {
      const cdp = await ctx.newCDPSession(page);
      try {
        await page.evaluate(() => setReasoningProfile('auto'));
        const r = await slider.boundingBox(), y = r.y + r.height / 2;
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r.x + 7, y }] });
        for (let step = 1; step <= 12; step++) {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: r.x + 7 + (r.width - 14) * step / 12, y }] });
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        assert.equal(await slider.inputValue(), '4', 'real touch drag reaches maximum');
        assert.equal(await page.evaluate(() => appState.reasoningProfile), 'max');
      } finally { await cdp.detach(); }
    } else if (mobile) {
      await page.evaluate(() => setReasoningProfile('auto'));
      const r = await slider.boundingBox();
      await page.touchscreen.tap(r.x + r.width - 7, r.y + r.height / 2);
      assert.equal(await slider.inputValue(), '4', 'native touch reaches maximum');
    }
    await slider.focus(); await slider.press('Home');
    assert.equal(await page.evaluate(() => appState.reasoningProfile), 'auto');
    await slider.press('End');
    assert.equal(await page.evaluate(() => appState.reasoningProfile), 'max');
    const names = ['DeepSeek V4.1 Flash', 'GPT 6.1 Sol', 'GPT 6 Luna', 'GPT 6 Astra'];
    for (const [lang, label] of [['zh-CN', '最大'], ['zh-TW', '最大'], ['en', 'Max']]) {
      const localized = await page.evaluate(lang => {
        setLanguage(lang); updateToolbarUI(); renderResearchModelControls();
        return {
          label: document.querySelector('[data-i18n="reasoning-max"]').textContent,
          unclipped: Array.from(document.querySelectorAll('.reasoning-profile-labels:not(.research-mode-labels) span')).every(el => { const r=el.getBoundingClientRect(),wrap=el.closest('.reasoning-profile-slider-wrap').getBoundingClientRect(); return r.left >= wrap.left - 1 && r.right <= wrap.right + 1; }),
          value: document.getElementById('reasoningProfileSlider').value,
          profile: appState.reasoningProfile,
          normalized: ['auto', 'low', 'medium', 'high', 'max', 'mixed', ' MAX ', 'bad'].map(normalizeReasoningProfile),
          models: Array.from(document.querySelectorAll('#modelDropdownMenu [data-model]')).filter(el => el.querySelector('.model-menu-name') && ['deepseek-v4.1-flash','gpt-6.1-sol','gpt-6-luna','gpt-6-astra'].includes(el.dataset.model)).map(el => ({ name: el.textContent.trim(), extras: !!el.querySelector('.model-badge,.model-menu-desc') })),
          agents: Array.from(document.querySelectorAll('#researchAgentModelList button')).map(el => el.textContent.trim()),
          masters: Array.from(document.querySelectorAll('#researchMasterModelSelect option')).map(el => el.textContent.trim())
        };
      }, lang);
      assert.equal(localized.label, label);
      assert.equal(localized.unclipped, true, 'Adaptive/Max labels stay inside the slider wrapper in every locale');
      assert.equal(localized.value, '4'); assert.equal(localized.profile, 'max');
      assert.deepEqual(localized.normalized, ['auto', 'low', 'medium', 'high', 'max', 'max', 'max', 'low']);
      assert.deepEqual(localized.models, names.map(name => ({ name, extras: false })));
      assert.deepEqual(localized.agents, names); assert.deepEqual(localized.masters, names);
    }
    const requestProfiles = await page.evaluate(() => {
      const manual = getRequestReasoningProfileForCurrentMode();
      toggleThinkingFromMenu({stopPropagation(){}}); toggleThinkingFromMenu({stopPropagation(){}});
      return {manual, adaptive: getRequestReasoningProfileForCurrentMode(), thinking: getModeRequestConfig('think').reasoningProfile};
    });
    assert.deepEqual(requestProfiles, {manual:'max', adaptive:'auto', thinking:'auto'});
    await page.locator('#moreBtn').click();

    // Click fallback, selection preservation, and native textarea caret placement.
    const fallback = await page.evaluate(() => {
      const input = document.getElementById('messageInput');
      input.value = 'abcdef'; input.setSelectionRange(2, 4); input.blur();
      document.querySelector('.input-toolbar').click();
      return { focused: document.activeElement === input, start: input.selectionStart, end: input.selectionEnd };
    });
    assert.deepEqual(fallback, { focused: true, start: 2, end: 4 });
    await input.fill('abcdef');
    await input.evaluate(el => el.setSelectionRange(0, 1));
    await page.keyboard.insertText('Z');
    assert.equal(await input.inputValue(), 'Zbcdef');
    await input.click();
    assert.equal(await input.evaluate(el => document.activeElement === el), true);
    // More/model controls really open; the blank-surface handler must not steal their actions.
    await input.evaluate(el => el.blur());
    await page.locator('#moreBtn').click();
    assert.equal(await page.locator('#moreMenu').evaluate(el => el.classList.contains('active')), true);
    const controlFocus = await page.evaluate(() => {
      const input = document.getElementById('messageInput');
      const original = input.focus; let count = 0; input.focus = () => count++;
      try {
        for (const control of document.querySelectorAll('#inputContainer button, #inputContainer [role="button"], #moreMenu input[type="range"]')) {
          handleInputContainerClick({target:control, type:'pointerdown',button:0,isPrimary:true,preventDefault(){throw new Error('control pointer was cancelled');}});
        }
        return count;
      } finally { input.focus = original; }
    });
    assert.equal(controlFocus, 0);
    await page.locator('#moreBtn').click();
    await page.evaluate(() => { appState.handednessEnabled = false; applyHandednessLayout(); });
    const modelButton = page.locator(mobile ? '#mobileModelSelectCustom' : '#modelSelectCustom');
    await modelButton.click();
    assert.equal(await page.locator('#modelDropdownMenu').evaluate(el => el.classList.contains('active')), true);
    await page.evaluate(() => closeModelModal());
    // SVG children of send/stop must keep their action; never make real chat calls.
    await page.evaluate(() => {
      window.composerFixtureActions = [];
      window.handleSendButtonClick = () => window.composerFixtureActions.push('send');
      window.stopGeneration = () => window.composerFixtureActions.push('stop');
    });
    await input.evaluate(el => el.blur());
    await page.locator('#sendBtn svg').click();
    await page.evaluate(() => {
      document.getElementById('sendBtn').style.display = 'none';
      document.getElementById('stopBtn').style.display = 'flex';
    });
    await page.locator('#stopBtn svg').click();
    assert.deepEqual(await page.evaluate(() => window.composerFixtureActions), ['send', 'stop']);
    // Disabled/read-only fields and sliders must not become focused by bubbling.
    const guards = await page.evaluate(() => {
      const input = document.getElementById('messageInput'), toolbar = document.querySelector('.input-toolbar');
      input.blur(); input.disabled = true; toolbar.click(); const disabled = document.activeElement !== input;
      input.disabled = false; input.readOnly = true; toolbar.click(); const readOnly = document.activeElement !== input;
      input.readOnly = false;
      const slider = document.querySelector('#inputContainer input[type="range"]');
      if (!slider) throw new Error('reasoning slider missing');
      slider.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, isPrimary: true }));
      const control = document.activeElement !== input;
      toolbar.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 2, isPrimary: true }));
      const secondary = document.activeElement !== input;
      toolbar.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, isPrimary: false }));
      const multiTouch = document.activeElement !== input;
      const event = new MouseEvent('click', { bubbles: true, cancelable: true }); event.preventDefault(); toolbar.dispatchEvent(event);
      return { disabled, readOnly, control, secondary, multiTouch, cancelled: document.activeElement !== input };
    });
    for (const [guard, passed] of Object.entries(guards)) assert.equal(passed, true, guard);
    // Native picker responds from its icon, text, padding and far right, not text only.
    await page.evaluate(() => {
      document.getElementById('sendBtn').style.display = 'flex';
      document.getElementById('stopBtn').style.display = 'none';
    });
    for (const hit of ['left', 'icon', 'text', 'right']) {
      await page.locator('#moreBtn').click();
      await page.waitForTimeout(160);
      const button = page.locator('#attachmentUploadBtn');
      const r = await button.boundingBox();
      const chooserPromise = page.waitForEvent('filechooser', {timeout:10000});
      const x = hit === 'left' ? 4 : hit === 'icon' ? 20 : hit === 'text' ? 85 : r.width - 4;
      if (mobile) await button.tap({position:{x,y:r.height/2}});
      else await button.click({position:{x,y:r.height/2}});
      const chooser = await chooserPromise;
      assert.equal(chooser.isMultiple(), true);
      await chooser.setFiles([]);
      assert.equal(await page.locator('#moreMenu').evaluate(el => el.classList.contains('active')), false);
    }
    // Real FileList -> fetch upload-session -> multipart XHR -> preview -> chat metadata.
    let uploadIndex = 0;
    const uploads = new Map(), namesUploaded = [];
    await page.route('**/api/uploads/sessions', async route => {
      const payload = route.request().postDataJSON();
      const id = 'upl_' + String(++uploadIndex).padStart(32, '0'); uploads.set(id, payload);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success:true, uploadId:id }) });
    });
    await page.route('**/api/upload', async route => {
      const file = uploads.get(route.request().headers()['x-rai-upload-id']);
      assert.ok(file, 'every multipart transfer uses its own upload session');
      assert.match(route.request().headers()['content-type'], /multipart\/form-data/);
      await page.waitForTimeout(40);
      namesUploaded.push(file.fileName);
      await route.fulfill({ status:200, contentType:'application/json', body:JSON.stringify({ success:true,status:'completed',file:{ filename:'owned-' + file.fileName, filePath:'/api/uploads/owned-' + file.fileName } }) });
    });
    const captured = [];
    await page.route('**/api/chat/stream', async route => {
      captured.push(route.request().postDataJSON());
      await route.fulfill({status:200,contentType:'text/event-stream',body:'data: {"type":"done","actualModel":"gpt-6.1-sol"}\n\ndata: [DONE]\n\n'});
    });
    await page.evaluate(() => { appState.token = 'fixture-only-not-a-real-credential'; appState.currentSession={id:'composer-fixture',model:'gpt-6.1-sol'}; });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/yUAAAAASUVORK5CYII=', 'base64');
    const files = [
      { name:'first.png',mimeType:'image/png',buffer:png },
      { name:'second.png',mimeType:'image/png',buffer:png },
      { name:'notes.txt',mimeType:'text/plain',buffer:Buffer.from('fixture notes') }
    ];
    await page.locator('#fileInput').setInputFiles(files);
    await page.waitForFunction(() => !pendingAttachmentUpload && currentAttachments.length === 3);
    assert.equal(await page.locator('#attachmentPreview .attachment-preview').count(),3);
    assert.equal(await page.locator('#attachmentPreview .attachment-thumbnail').count(),2);
    await page.locator('#attachmentPreview .attachment-remove').nth(1).click();
    assert.deepEqual(await page.evaluate(() => currentAttachments.map(a=>a.fileName)),['first.png','notes.txt']);
    await page.locator('#fileInput').setInputFiles([{name:'third.png',mimeType:'image/png',buffer:png},{name:'extra.txt',mimeType:'text/plain',buffer:Buffer.from('fixture extra')}]);
    // Append another batch while the previous one is still in flight, then send immediately.
    await page.locator('#fileInput').setInputFiles([{name:'queued.txt',mimeType:'text/plain',buffer:Buffer.from('queued fixture')}]);
    // Use actual sending code, with only session identity mocked in this no-account fixture.
    await page.evaluate(() => {
      window.ensureCurrentSessionPromptIdentity = async () => {};
      appState.selectedModel='gpt-6.1-sol'; appState.currentSessionMemoryMode='classic-temp';
      appState.isStreaming=false; appState.sendStarting=false; appState.messages=[];
      document.getElementById('messageInput').value='请比较图片并结合两个文件回答';
      window.composerFixtureSend = sendMessage();
    });
    await page.waitForFunction(() => currentAttachments.length === 0);
    await page.waitForTimeout(100);
    assert.equal(captured.length,1,'one question carries all selected attachments');
    const message=captured[0].messages.findLast(m=>m.role==='user');
    assert.deepEqual(message.attachments.map(a=>a.fileName),['first.png','notes.txt','third.png','extra.txt','queued.txt']);
    assert.ok(message.attachments.every(a=>a.fileId&&a.filePath&&!('localThumbnail' in a)&&!('data' in a)));
    assert.equal(captured[0].reasoningProfile,'auto');
    assert.ok(message.content.includes('请比较图片并结合两个文件回答'));
    assert.deepEqual(namesUploaded,['first.png','second.png','notes.txt','third.png','extra.txt','queued.txt']);
    const cancelled = await page.evaluate(async () => {
      const task=processUploadedFiles([new File(['one'],'discard-a.txt',{type:'text/plain'}),new File(['two'],'discard-b.txt',{type:'text/plain'})]);
      removeAttachment(); await task;
      return currentAttachments.length;
    });
    assert.equal(cancelled,0);
    assert.ok(!namesUploaded.includes('discard-b.txt'),'remaining cancelled files are not uploaded');
    const accountChanged = await page.evaluate(async () => {
      const task=processUploadedFiles([new File(['fixture'],'old-account.txt',{type:'text/plain'})]);
      appState.authEpoch++; appState.token='another-fixture-only-token'; removeAttachment(); await task;
      return currentAttachments.length;
    });
    assert.equal(accountChanged,0);
    if (mobile) {
      await page.evaluate(async () => {
        closeMoreMenu(); closeModelModal(); document.getElementById('messageInput').blur();
        appState.messages=Array.from({length:18},(_,i)=>({role:i%2?'assistant':'user',content:i%2 ? ('回复正文用于上下滑动查看历史。\n\n'.repeat(35)) : '问题 '+i}));
        renderMessages(); await new Promise(resolve=>setTimeout(resolve,120)); cancelPendingAutoScroll();
        const chat=getChatScrollElement(); chat.scrollTop=chat.scrollHeight;
        appState.lastScrollTop=chat.scrollTop; appState.isProgrammaticScroll=false;setScrollFollowMode('following');
      });
      const before=await page.evaluate(()=>getChatScrollElement().scrollTop);
      const target=await page.evaluate(()=>{const el=document.elementFromPoint(window.innerWidth/2,400);return {text:!!el?.closest('.message.assistant'),tag:el?.tagName};});
      assert.equal(target.text,true,'gesture originates on an assistant reply: '+JSON.stringify(target));
      if(engine===chromium) {
        const cdp=await ctx.newCDPSession(page);
        try {
          const x=fixture.width/2;
          await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y:400}]});
          for(let step=1;step<=12;step++){
            await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+step*0.2,y:400+step*20}]});
            await page.evaluate(()=>scrollToBottom()); await page.waitForTimeout(16);
          }
          await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
        }finally{await cdp.detach();}
      } else {
        // WebKit has no native touch-move driver. Verify unconsumed touch listeners
        // and then browser scrolling; physical iOS acceptance remains separate.
        const passive=await page.evaluate(()=>{
          const target=document.elementFromPoint(window.innerWidth/2,400);
          const touch=(type,y)=>{const t={identifier:1,target,clientX:window.innerWidth/2,clientY:y};const e=new Event(type,{bubbles:true,cancelable:true});Object.defineProperty(e,'touches',{value:type==='touchend'?[]:[t]});Object.defineProperty(e,'changedTouches',{value:[t]});target.dispatchEvent(e);return e.defaultPrevented;};
          touch('touchstart',400);const blocked=touch('touchmove',640);const paused=appState.scrollFollowMode==='pausedByUser';touch('touchend',640);return {blocked,paused};
        });
        assert.deepEqual(passive,{blocked:false,paused:true});await page.mouse.move(fixture.width/2,400);await page.mouse.wheel(0,-300);
      }
      await page.waitForTimeout(160);
      const after=await page.evaluate(()=>({top:getChatScrollElement().scrollTop,mode:appState.scrollFollowMode,sidebar:appState.sidebarOpen}));
      assert.ok(after.top < before-60,JSON.stringify({fixture,before,after}));assert.equal(after.mode,'pausedByUser');assert.equal(after.sidebar,false);
      await page.evaluate(()=>scrollToBottom());await page.waitForTimeout(100);
      assert.ok(await page.evaluate(()=>getChatScrollElement().scrollTop) < before-60,'stream updates do not drag readers back to the bottom');
    }
    assert.deepEqual(chatCalls, []);

    console.log('composer-focus-runtime PASS', fixture.platform, fixture.standalone ? 'PWA' : 'browser', checked, 'blank-surface hits');
  } finally { await ctx.close(); }
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await engine.launch({ headless: true, ...(process.env.RAI_QR_BROWSER_EXECUTABLE ? { executablePath: process.env.RAI_QR_BROWSER_EXECUTABLE } : {}) });
    const url = process.env.RAI_UI_BASE_URL || 'http://127.0.0.1:' + server.address().port;
    for (const fixture of cases.filter(x=>!process.env.RAI_FOCUS_CASE||x.platform===process.env.RAI_FOCUS_CASE)) await testCase(browser, url, fixture);
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
