'use strict';
// Run against an integration checkout: node this-file.js --root ABSOLUTE_REPO [--browser]
// --overlay points at proposed source copies for a read-only red/green review.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
function arg(name) { const index = process.argv.indexOf(name); return index < 0 ? '' : process.argv[index + 1]; }
const root = path.resolve(arg('--root') || path.join(__dirname, '..'));
const overlay = arg('--overlay') ? path.resolve(arg('--overlay')) : '';
const requireFromRoot = createRequire(path.join(root, 'package.json'));
function source(file) {
  const candidate = overlay && path.join(overlay, file);
  return fs.readFileSync(candidate && fs.existsSync(candidate) ? candidate : path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
}
function between(text, start, end) {
  const a = text.indexOf(start), b = text.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, 'Production extraction moved: ' + start);
  return text.slice(a, b);
}
const server = source('server.js');
const promptContext = { module: { exports: {} } };
vm.runInNewContext(source('public/rai-system-prompt.js'), promptContext);
const prompt = promptContext.module.exports;
const buildToolRoundInstruction = prompt.buildToolRoundInstruction;
const checks = [];

function emitter(rounds) {
  const events = [];
  const c = vm.createContext({
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
    let serverFinalAnswerOffset=-1,activeServerFlowContent=null,liveStreamState={assistantContent:''};
    let completedToolRounds=${rounds},finalSummaryMinimumOffset=0;
    ${between(server, 'const emitStructuredAssistantChunk =', 'const emitStructuredReasoningChunk =')}
    globalThis.emit=emitStructuredAssistantChunk;
    globalThis.crossNinth=()=>{completedToolRounds=9;finalSummaryMinimumOffset=rawAssistantStructuredBuffer.length;};
  `, c);
  return { events, emit: c.emit, crossNinth: c.crossNinth, value: name => vm.runInContext(name, c) };
}

function exerciseHandoff(batches) {
  const handoff = between(server,
    '                        if (executedToolResults.length === 0 && !deliveredInterjection',
    '                        const continueRequestBody = {');
  const c = vm.createContext({ buildToolRoundInstruction, batches, console: { log() {}, warn() {} } });
  vm.runInContext(`
    let completedToolRounds=0,finalSummaryMinimumOffset=0;
    let latestStructuredAssistantOutput={visibleContent:'already streamed'},rawAssistantStructuredBuffer='already streamed';
    let conversationMessages=[],pendingToolCalls=[],toolRoundContent='';
    const activeRequestInterjections=new Map(),requestId='fixture',gptImageModelSelected=false;
    const directImageToolSucceeded=false,directImageToolFailed=false,directImageToolMessage='';
    const isCurrentKimiK25Model=()=>false,toolResultForContext=x=>x,collectRequestInterjections=()=>[];
    const currentToolCallReasoningContent='',uiLanguage='en',TOOL_TRUNCATION_MESSAGE='unused';
    const chatModelQuotaContext={getStore:()=>null},res={writableEnded:false,write(){}},emitStructuredAssistantChunk=()=>{};
    const counts=[];
    for(const batch of batches){
      const executedToolResults=batch.results,deliveredInterjection=!!batch.interjection;
      toolRoundContent=batch.text||'';
      ${handoff}
      counts.push(completedToolRounds);
    }
    globalThis.result={completedToolRounds,finalSummaryMinimumOffset,conversationMessages,counts};
  `, c);
  return JSON.parse(JSON.stringify(c.result));
}
function resultCall(id, failed = false) {
  return { toolCall: { id, function: { name: 'read_file', arguments: '{}' } }, result: failed ? { success: false, error: 'fixture_error' } : { success: true } };
}

async function agentLoop(rounds, toolsPerRound = 1) {
  const requests = [], executions = [], output = [];
  let responseNumber = 0;
  const fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    const index = responseNumber++;
    const tools = index < rounds ? Array.from({ length: toolsPerRound }, (_, tool) => ({
      index: tool, id: `r${index}-t${tool}`, type: 'function', function: { name: 'read_file', arguments: '{}' }
    })) : [];
    const content = tools.length ? `progress-${index}\n` : 'Only final body.';
    const event = { choices: [{ delta: { content, ...(tools.length ? { tool_calls: tools } : {}) }, finish_reason: tools.length ? 'tool_calls' : 'stop' }] };
    return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
  };
  const context = vm.createContext({
    console: { log() {}, warn() {} }, AbortController, TextDecoder, DOMException,
    setTimeout, clearTimeout, fetchModelProvider: fetch, buildToolRoundInstruction,
    TOOL_DEFINITIONS: [{ type: 'function', function: { name: 'read_file' } }],
    isKimiK25ActualModel: () => false, resolveThinkingBudgetForModel: () => null,
    throwIfExternalRequestAborted: signal => { if (signal?.aborted) throw signal.reason; },
    linkImageProviderAbort: () => () => {}, normalizeUsage: value => value || {},
    extractReasoningTextFromPayload: () => '', assignStableSourceMarkers: value => value,
    normalizeToolCalls: calls => calls.map(call => ({ ...call, _args: {} })),
    executeNormalizedToolCall: async ({ toolCall }) => { executions.push(toolCall.id); return { result: { success: true }, sources: [], searchCountInc: 0 }; },
    appendAnnotatedSources: (current, sources) => ({ merged: current.concat(sources), newlyAdded: sources }),
    emitSourcesEvent: () => {}, buildToolResultForLLM: ({ result }) => result,
    dedupeSources: value => value
  });
  const start = server.indexOf('async function callK2p5Stream(');
  const rest = server.slice(start);
  const end = rest.slice(1).search(/\n(?:async )?function /) + 1;
  assert.ok(start >= 0 && end > 0);
  vm.runInContext(rest.slice(0, end) + '\nglobalThis.run=callK2p5Stream;', context);
  const result = await context.run({ providerConfig: { baseURL: 'http://provider.test', apiKey: 'fixture' },
    actualModel: 'fixture', messages: [{ role: 'user', content: 'fixture task' }], internetMode: true,
    maxTokens: 1000, maxToolRounds: rounds + 1, searchBudget: {}, taskKey: 'fixture',
    onContent: text => output.push(text), onReasoning() {} });
  assert.equal(executions.length, rounds * toolsPerRound);
  assert.equal(requests.length, rounds + 1, 'No second finalization request after a completed final answer');
  assert.equal(output.filter(text => text === 'Only final body.').length, 1);
  assert.equal(result.content, output.join(''), 'Streaming and returned content agree');
  for (let index = 1; index <= rounds; index++) {
    const status = requests[index].messages.filter(m => m.name === 'rai_tool_round_status');
    assert.equal(status.length, index, 'Round status appends without changing cached prefix bytes');
    assert.equal(status.at(-1).content, buildToolRoundInstruction(index));
    assert.deepEqual(requests[index].messages.slice(0, requests[index - 1].messages.length), requests[index - 1].messages,
      'tool continuation preserves all previously sent prompt bytes');
    const lastAssistant = requests[index].messages.filter(m => m.role === 'assistant').at(-1);
    assert.equal(lastAssistant.content, `progress-${index - 1}\n`, 'Agent continuation must retain text already streamed');
  }
  return { rounds, toolsPerRound, providerRequests: requests.length };
}

async function browserChecks() {
  const { chromium, webkit } = requireFromRoot('playwright');
  const engine = process.env.RAI_BROWSER_ENGINE === 'webkit' ? webkit : chromium;
  const browser = await engine.launch({ headless: true,
    ...(process.env.RAI_QR_BROWSER_EXECUTABLE ? { executablePath: process.env.RAI_QR_BROWSER_EXECUTABLE } : {}) });
  try {
    const page = await browser.newPage({ serviceWorkers: 'block' });
    const origin = 'https://tool-finalization.test';
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname.startsWith('/api/')) {
        const body = url.pathname.endsWith('/runtime-config') ? {} : { success: true, messages: [], models: [], sessions: [], memories: [], count: 0, enabled: false };
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      }
      const relative = 'public/' + (url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
      const file = path.resolve(root, relative);
      if (!file.startsWith(path.resolve(root, 'public') + path.sep)) return route.fulfill({ status: 404, body: '' });
      try {
        const candidate = overlay && path.join(overlay, relative);
        const actual = candidate && fs.existsSync(candidate) ? candidate : file;
        const body = fs.readFileSync(actual);
        const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png' }[path.extname(actual)] || 'application/octet-stream';
        return route.fulfill({ contentType: mime, body });
      } catch (_) { return route.fulfill({ status: 404, body: '' }); }
    });
    await page.goto(origin + '/');
    await page.waitForFunction(() => typeof prepareMessageElement === 'function' && typeof finishMessageNodeInPlace === 'function');
    const counts = await page.evaluate(() => {
      appState.user = { id: 7 }; appState.token = 'fixture';
      appState.currentSession = { id: 'tool-round-fixture', title: 'fixture', model: 'gpt-6-luna' };
      const bodies = [];
      for (const rounds of [0, 2, 3, 8, 9]) {
        const text = 'FINAL_BODY_' + rounds + '_ONCE';
        const trace = { flowSegments: [{ kind: 'content', content_offset: 0, text: 'Progress\n' },
          ...Array.from({ length: rounds }, (_, index) => ({ kind: 'tool', title: 'Read', status: 'done', toolCallId: 'r' + index })),
          { kind: 'content', content_offset: 9, text }], finalAnswerOffset: rounds > 8 ? 9 : -1 };
        const final = { id: 100 + rounds, role: 'assistant', content: 'Progress\n' + text,
          model: 'gpt-6-luna', process_trace: trace };
        const saved = prepareMessageElement(final, { animate: false });
        document.getElementById('messagesList').appendChild(saved);
        const before = (saved.textContent.match(new RegExp(text, 'g')) || []).length;
        const live = prepareMessageElement({ ...final, is_live_stream: true }, { animate: false });
        document.getElementById('messagesList').appendChild(live);
        finishMessageNodeInPlace(live, final, { sessionId: appState.currentSession.id, generation: appState.sessionNavigationGeneration });
        const after = (live.textContent.match(new RegExp(text, 'g')) || []).length;
        bodies.push({ rounds, saved: before, finalized: after, messageTextNodes: live.querySelectorAll('.message-content > .message-text').length });
        saved.remove(); live.remove();
      }
      return bodies;
    });
    for (const item of counts) {
      assert.equal(item.saved, 1, `Reload body duplicated after ${item.rounds} rounds`);
      assert.equal(item.finalized, 1, `Completion graft duplicates body after ${item.rounds} rounds`);
      assert.equal(item.messageTextNodes, 1);
    }
    checks.push('Full index/app browser: one saved/completed DOM body at 0/2/3/8/9 rounds (' + engine.name() + ')');
  } finally { await browser.close(); }
}

(async () => {
  if (process.argv.includes('--baseline-evidence')) {
    const short = emitter(2);
    short.emit('Already delivered.');
    short.emit('[RAI_FINAL]Repeated delivery.');
    assert.equal(short.events.filter(event => event.type === 'answer_start').length, 1,
      'Baseline currently accepts the separate final boundary even at two rounds');
    const handoff = exerciseHandoff([{ results: [resultCall('check')], text: 'Already delivered.' }]);
    assert.equal(handoff.conversationMessages.find(message => message.role === 'assistant').content, null,
      'Baseline drops the previously streamed assistant content');
    console.log('BASELINE CONFIRMED: separate-final boundary accepted at 2 rounds; next tool request receives assistant.content=null.');
    if (process.argv.includes('--browser')) {
      await browserChecks();
      console.log(checks.at(-1));
    }
    return;
  }
  assert.equal(typeof buildToolRoundInstruction, 'function', 'Authoritative completed-round policy is missing');
  for (const count of [0, 1, 2, 3, 8]) {
    assert.match(buildToolRoundInstruction(count), /one ordinary answer/);
    assert.match(buildToolRoundInstruction(count), /Do not regenerate/);
  }
  for (const count of [9, 10, 45]) assert.match(buildToolRoundInstruction(count), /one self-contained final summary/);
  assert.throws(() => buildToolRoundInstruction(-1));
  assert.throws(() => buildToolRoundInstruction(1.5));
  const en = prompt.buildSystemPrompt({ promptLanguage: 'en' });
  const zh = prompt.buildSystemPrompt({ promptLanguage: 'zh-CN' });
  assert.match(en, /Through 8 completed rounds/);
  assert.match(en, /9 or more completed rounds/);
  assert.match(zh, /8\u8f6e/); assert.match(zh, /9\u8f6e/);
  assert.notEqual(buildToolRoundInstruction(8, 'zh-CN'), buildToolRoundInstruction(9, 'zh-CN'));
  checks.push('Bilingual 0..8/9+ authoritative policy, valid integer count');

  const batch = id => ({ results: [resultCall(id)], text: 'Visible body before ' + id });
  const retryPath = between(server, 'for (let continueAttempt = 0;', '                        pendingToolCalls = normalizeToolCalls(continueAccumulatedToolCalls, clientFileExecution);');
  assert.doesNotMatch(retryPath, /completedToolRounds\s*(?:\+\+|\+=)/,
    'A provider stream retry must not count as another completed tool round');
  for (const count of [2, 3, 8, 9]) {
    const result = exerciseHandoff(Array.from({ length: count }, (_, index) => batch('r' + index)));
    assert.equal(result.completedToolRounds, count);
    const status = result.conversationMessages.filter(m => m.name === 'rai_tool_round_status');
    assert.equal(status.length, count);
    assert.equal(status.at(-1).content, buildToolRoundInstruction(count));
    assert.equal(result.conversationMessages.filter(m => m.role === 'assistant').at(-1).content, 'Visible body before r' + (count - 1));
  }
  assert.equal(exerciseHandoff([{ results: Array.from({ length: 12 }, (_, n) => resultCall('same-' + n)), text: 'Already shown.' }]).completedToolRounds, 1);
  assert.equal(exerciseHandoff([{ results: [], interjection: true }, batch('r0'), { results: [], interjection: true }]).completedToolRounds, 1);
  assert.equal(exerciseHandoff([{ results: [resultCall('error', true)] }]).completedToolRounds, 1, 'Returned error is completed; thrown/unfinished calls have no handoff');
  assert.equal(exerciseHandoff([{ results: [] }]).completedToolRounds, 0);
  checks.push('Actual Web handoff: 12 calls=1 round; 2/3/8/9 batches; no-result/interjection excluded; text retained; append-only round status');
  const gemini = vm.createContext({ messageContentAsText: content => content });
  vm.runInContext(between(server, 'function getCanonicalSystemInstruction(', 'function buildChatToolDefinitions(')
    + '\nglobalThis.convert=buildGeminiContinuationContents;globalThis.system=getCanonicalSystemInstruction;', gemini);
  const continuedMessages = exerciseHandoff([batch('gemini')]).conversationMessages;
  const geminiParts = gemini.convert(continuedMessages)[0].parts;
  assert.equal(geminiParts[0].text, 'Visible body before gemini', 'Gemini must also retain streamed tool-call text');
  assert.equal(geminiParts[1].functionCall.name, 'read_file');
  assert.match(JSON.stringify(gemini.convert(continuedMessages)), /1 completed tool rounds/);
  checks.push('Actual Gemini converter: assistant text + functionCall and current completed-round instruction preserved');

  for (const count of [0, 2, 3, 8, 9]) {
    const e = emitter(count);
    e.emit('Progress\n');
    e.emit('[RAI_FI'); e.emit('NAL]'); e.emit('Only final body.');
    assert.equal(e.events.filter(event => event.type === 'answer_start').length, count > 8 ? 1 : 0);
    assert.equal(e.events.filter(event => event.type === 'content').map(event => event.content).join('').split('Only final body.').length - 1, 1);
  }
  const stale = emitter(2);
  stale.emit('[RAI_FINAL]Early text.');
  assert.equal(stale.events.filter(event => event.type === 'answer_start').length, 0);
  stale.crossNinth(); stale.emit('More progress.');
  assert.equal(stale.events.filter(event => event.type === 'answer_start').length, 0, 'An early marker cannot become eligible later');
  stale.emit('[RAI_FINAL]Late final.');
  assert.equal(stale.events.filter(event => event.type === 'answer_start').length, 1);
  assert.equal(stale.value('serverFinalAnswerOffset'), 'Early text.More progress.'.length);
  for (const early of ['[RAI_FINAL]', 'Progress[RAI_FINAL]', 'Progress[RAI_FI']) {
    const pending = emitter(8);
    pending.emit(early); pending.crossNinth();
    pending.emit(early.endsWith('[RAI_FI') ? 'NAL]Later progress.' : 'Later progress.');
    assert.equal(pending.events.filter(event => event.type === 'answer_start').length, 0,
      'A marker begun before the ninth completed batch cannot become eligible later: ' + early);
    pending.emit('[RAI_FINAL]One final answer.');
    assert.equal(pending.events.filter(event => event.type === 'answer_start').length, 1);
  }
  checks.push('Actual parser/SSE emitter: 8 is short, 9 eligible, split/early markers, exactly one body/start');

  for (const count of [2, 3, 8, 9]) await agentLoop(count, count === 3 ? 4 : 1);
  checks.push('Actual managed-agent loop: 2/3/8/9 rounds, parallel tools=one batch, preserved assistant content, one final provider response');
  if (process.argv.includes('--browser')) await browserChecks();
  for (const check of checks) console.log('PASS ' + check);
})().catch(error => { console.error(error); process.exitCode = 1; });
