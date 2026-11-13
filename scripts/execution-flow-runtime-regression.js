'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { chromium, webkit } = require('playwright');
const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
function between(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `Production extraction moved: ${start}`);
  return source.slice(a, b);
}
const events = [];
const context = vm.createContext({
  removeInternalAssistantSections: text => text,
  shouldHoldAssistantVisibleContent: () => false,
  recordServerFlowContent: () => {},
  persistSessionStreamDraft: () => {}, broadcastSessionStreamState: () => {},
  chatModelQuotaContext: { getStore: () => null }, actualModel: 'fixture',
  res: { write: wire => events.push(JSON.parse(wire.slice(6))) }
});
vm.runInContext(`
const TITLE_START_TOKEN='[TITLE]',TITLE_END_TOKEN='[/TITLE]',FINAL_ANSWER_TOKEN='[RAI_FINAL]';
const CANVAS_OPS_START_TOKEN='[CANVAS_OPS]',CANVAS_OPS_END_TOKEN='[/CANVAS_OPS]';
const STRUCTURED_OUTPUT_TOKENS=[TITLE_START_TOKEN,TITLE_END_TOKEN,FINAL_ANSWER_TOKEN,'[/RAI_FINAL]',CANVAS_OPS_START_TOKEN,CANVAS_OPS_END_TOKEN];
${between(server, 'function trimStructuredTokenPrefix(', 'function parseCanvasPatchPayload(')}
${between(server, 'function extractLegacyTrailingTitle(', 'function sanitizeGeneratedConversationTitle(')}
${between(server, 'function sanitizeAssistantVisibleContent(', 'function shouldHoldAssistantVisibleContent(')}
let rawAssistantStructuredBuffer='',latestStructuredAssistantOutput={},fullContent='',assistantVisibleStarted=false;
let serverFinalAnswerOffset=-1,activeServerFlowContent=null,liveStreamState={assistantContent:''},completedToolRounds=9,finalSummaryMinimumOffset=0;
${between(server, 'const emitStructuredAssistantChunk =', 'const emitStructuredReasoningChunk =')}
globalThis.emit=emitStructuredAssistantChunk;
`, context);

(async () => {
  // Exercise the real parser/emitter with a same-chunk progress/final boundary and Unicode.
  context.emit('Straße 完成😀\n\n[RAI_FI');
  assert.ok(!events.some(event => event.type === 'answer_start'));
  context.emit('NAL]');
  assert.ok(!events.some(event => event.type === 'answer_start'));
  context.emit('\n');
  assert.ok(!events.some(event => event.type === 'answer_start'));
  context.emit('总');
  const start = events.findIndex(event => event.type === 'answer_start');
  assert.equal(events[start + 1].type, 'content');
  assert.equal(events[start + 1].content.trim(), '总');
  assert.equal(events.filter(event => event.type === 'content').map(event => event.content).join(''), 'Straße 完成😀\n\n总');
  assert.equal(vm.runInContext('liveStreamState.assistantContent', context), 'Straße 完成😀\n\n总');
  context.emit('结[TITLE]报告[/TITLE]');
  assert.equal(events.filter(event => event.type === 'answer_start').length, 1);

  const engine = process.env.RAI_BROWSER_ENGINE === 'webkit' ? webkit : chromium;
  const browser = await engine.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<main id="flow"></main>');
    await page.addScriptTag({ content: `
      const appState={language:'zh-CN'};
      const isChineseLanguage=()=>true;
      const sanitizeAssistantDisplayText=text=>text;
      const extractAskUserBlocks=text=>({text});
      const stripIncompleteAskUserFence=text=>text;
      const sanitizeRenderedHtml=text=>text;
      const renderMarkdownWithMath=text=>text;
      const hydrateRenderedImages=()=>{};
      const renderCitations=text=>text;
      const scrollToBottom=()=>{};
      ${between(app, 'function projectAssistantExecution(', 'function prepareMessageElement(')}
      const streamingEl=document.getElementById('flow'),currentSources=[],timelineDynamicSteps=null;
      let fullContent='';
      ${between(app, 'const streamFlowSegments = [];', '// ==================== AI Smooth Fusion')}
      function receive(event){
        if(event.type==='content'){fullContent+=event.content;appendInterleavedContent(event.content);}
        else if(event.type==='answer_start'){finalAnswerOffset=event.content_offset;activeFlowContent=null;}
        else appendInterleavedEvent('tool','Read file',event.detail,event.status,event);
      }
    ` });
    await page.evaluate(() => {
      receive({ type: 'content', content: 'First report\n' });
      receive({ type: 'tool_status', tool_call_id: 'one', detail: 'First command', status: 'running' });
      receive({ type: 'content', content: 'Second report\n' });
      receive({ type: 'tool_status', tool_call_id: 'two', detail: 'Second command', status: 'running' });
      receive({ type: 'tool_status', tool_call_id: 'one', detail: 'First result', status: 'done' });
    });
    assert.equal(await page.locator('.execution-process').count(), 0, 'Progress stays in the body until a final answer starts');
    assert.deepEqual(await page.locator('.execution-live-rows > *').allTextContents(),
      ['First report\n', 'Read fileFirst result', 'Second report\n', 'Read fileSecond command']);
    await page.evaluate(() => receive({ type: 'answer_start', content_offset: fullContent.length }));
    assert.equal(await page.locator('.execution-process').count(), 0);
    await page.evaluate(() => receive({ type: 'content', content: '\n ' }));
    assert.equal(await page.locator('.execution-process').count(), 0, 'A marker or whitespace alone cannot hide progress');
    await page.evaluate(() => receive({ type: 'content', content: '总' }));
    assert.equal(await page.locator('.execution-process').evaluate(element => element.open), false);
    assert.equal(await page.locator('.execution-live-rows').count(), 0);
    assert.equal((await page.locator('.execution-answer').textContent()).trim(), '总');
    await page.locator('.execution-process > summary').click();
    await page.locator('.stream-flow-event-toggle').first().click();
    await page.evaluate(() => receive({ type: 'content', content: '结与交付' }));
    assert.equal(await page.locator('.execution-process').evaluate(element => element.open), true);
    assert.equal(await page.locator('.stream-flow-event-toggle').first().getAttribute('aria-expanded'), 'true');
    await page.evaluate(() => { streamComplete=true;renderInterleavedFlow(); });
    assert.equal(await page.locator('.execution-process').evaluate(element => element.open), true);
    assert.equal((await page.locator('.execution-answer').textContent()).trim(), '总结与交付');
    // Reload using only the persisted trace, the same renderer and a fresh DOM.
    await page.evaluate(() => {
      const saved=JSON.parse(JSON.stringify({flowSegments:streamFlowSegments,finalAnswerOffset}));
      streamingEl.replaceChildren();
      renderAssistantExecutionFlow(streamingEl,saved.flowSegments,{finalOffset:saved.finalAnswerOffset,complete:true});
    });
    assert.equal(await page.locator('.execution-process').evaluate(element => element.open), false);
    assert.equal((await page.locator('.execution-answer').textContent()).trim(), '总结与交付');
    assert.equal(await page.locator('.stream-flow-event').count(), 2);
    const fallback = await page.evaluate(() => {
      const rows=[{kind:'content',text:'Report'},{kind:'tool',title:'Command'},{kind:'content',text:'Done'}];
      return [projectAssistantExecution(rows,-1,false),projectAssistantExecution(rows,-1,true),
        projectAssistantExecution([{kind:'content',text:'Report',content_offset:100},{kind:'tool'},{kind:'content',text:'Done',content_offset:106}],106,true)];
    });
    assert.equal(fallback[0].finalStarted, false, 'Interrupted or unfinished work must stay in the body');
    assert.equal(fallback[1].answer, 'Done', 'A model without a final marker falls back only at completion');
    assert.equal(fallback[2].answer, 'Done', 'Trace truncation must preserve absolute final offsets');
    await page.evaluate(() => {
      streamingEl.replaceChildren();
      renderAssistantExecutionFlow(streamingEl, [{kind:'content',text:'Interrupted report'},{kind:'tool',title:'Read file',status:'running'}], {complete:false});
    });
    assert.equal(await page.locator('.execution-process').count(), 0, 'Reloading interrupted work must not hide it');
    assert.match(await page.locator('.execution-live-rows').textContent(), /Interrupted report/);
    assert.equal(await page.locator('.stream-flow-event').getAttribute('data-status'), 'unknown');
    console.log('PASS: production final parser/emitter and browser execution renderer: first character, ordering, correlated tools, expansion retention, reload, interruption and bounded trace');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
