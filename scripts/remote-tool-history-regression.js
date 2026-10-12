'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const begin = server.indexOf('        const serverToolTrace = [];');
const end = server.indexOf('\n        if (sessionId) {', begin);
assert.ok(begin >= 0 && end > begin, 'Production tool collector not found');
const lines = server.split(/\r?\n/);
const remoteComplete = lines.find(line => line.includes('emitTrackedToolStatus(') && line.includes('status: remoteResult.executed'));
const remoteStart = lines.find(line => line.includes('emitTrackedToolStatus(') && line.includes('cxRemoteSession.authorizationProtocol'));
const localComplete = lines.find(line => line.includes('emitTrackedToolStatus({ ...uiResult'));
const skillComplete = lines.find(line => line.includes('emitTrackedToolStatus(') && line.includes('trustedSkill.name') && line.includes("status: 'complete'"));
assert.ok(remoteComplete && remoteStart && localComplete && skillComplete, 'An early-return tool path bypasses persisted completion');
const make = vm.runInNewContext(`(res) => {
${server.slice(begin, end)}
return {
  tools: serverToolTrace, flow: serverFlowSegments,
  emit: emitTrackedToolStatus, content: recordServerFlowContent,
  remoteStart(toolName, toolCall, cxRemoteSession) { ${remoteStart} },
  remoteComplete(remoteResult, toolName, toolCall) { ${remoteComplete} },
  localComplete(uiResult, toolCall) { ${localComplete} },
  skillComplete(trustedSkill, toolCall) { ${skillComplete} }
};
}`, {}, {timeout: 2000});
function setup() { const events = []; const state = make({write(frame) { events.push(JSON.parse(frame.slice(6).trim())); }}); return {state, events}; }
let assertions = 0;
function check(actual, expected, detail) { assertions++; assert.deepEqual(actual, expected, detail); }
for (const result of [{success:true}, {success:false}, {success:true, executed:'unknown'}, {}]) {
  const {state, events} = setup();
  const call = {id:'write-1'};
  state.content('Before');
  state.remoteStart('write_file', call, {authorizationProtocol:'web-v2'});
  state.content('After authorization');
  state.remoteComplete(result, 'write_file', call);
  const expected = result.success === true && result.executed !== 'unknown' ? 'complete' : 'failed';
  check(state.tools.length, 1, 'Remote completion must update the same tool call');
  check(state.tools[0].status, expected, 'Remote history lies about execution status');
  check(state.flow.filter(s => s.kind === 'tool').length, 1, 'Remote history retains a stale duplicate running card');
  check(state.flow[1].status, expected === 'complete' ? 'done' : 'failed', 'Historical flow card did not complete');
  check(state.flow[2].text, 'After authorization', 'Updating a card loses surrounding narrative');
  check(events.length, 2, 'Completion SSE event lost');
  check(events[1].status, expected, 'Live and stored tool status diverge');
  if (expected === 'failed') check(events[1].message.includes('执行完成'), false, 'Unknown execution claims completion');
}
{
  const {state} = setup();
  state.remoteStart('write_file', {id:'a'}, {authorizationProtocol:'web-v2'});
  state.remoteStart('write_file', {id:'b'}, {authorizationProtocol:'web-v2'});
  state.remoteComplete({success:true}, 'write_file', {id:'b'});
  check(state.tools.length, 2, 'Concurrent calls collapsed');
  check(state.tools[0].status, 'running', 'Concurrent completion changes another call');
  check(state.flow[0].status, 'running', 'Concurrent flow status changes another call');
  check(state.flow[1].status, 'done', 'Targeted flow completion lost');
}
{
  const {state} = setup();
  state.emit({tool:'write_file',tool_call_id:'local',status:'running'});
  state.localComplete({type:'tool_status',tool:'write_file',status:'complete',message:'Completed'}, {id:'local'});
  check(state.tools.length, 1, 'Native completion correlation lost');
  check(state.tools[0].status, 'complete', 'Native completion omitted from durable trace');
  state.emit({tool:'read_skill',tool_call_id:'skill',status:'running'});
  state.skillComplete({name:'local_workdir'}, {id:'skill'});
  check(state.tools[1].status, 'complete', 'Loaded skill stays running in history');
}
{
  const {state} = setup();
  for (let i=0; i<250; i++) state.emit({tool:'read_file',tool_call_id:'c'+i,status:'complete'});
  check(state.tools.length, 200, 'Tool history is unbounded');
  check(state.flow.length, 200, 'Flow history is unbounded');
}
{
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const statusBegin = app.indexOf("      const storedStatus = String(segment.status || 'done');");
  const statusEnd = app.indexOf('\n', app.indexOf('      item.dataset.status =', statusBegin));
  const titleBegin = app.indexOf('      toggle.textContent = missingHistoricalResult', statusEnd);
  const titleEnd = app.indexOf(';', titleBegin) + 1;
  const detailBegin = app.indexOf("      const storedDetail = String(segment.detail || '');", titleEnd);
  const detailEnd = app.indexOf('        : storedDetail;', detailBegin) + '        : storedDetail;'.length;
  assert.ok(statusBegin >= 0 && statusEnd > statusBegin && titleBegin > statusEnd && titleEnd > titleBegin && detailBegin > titleEnd && detailEnd > detailBegin, 'Historical tool status presentation missing');
  const normalize = vm.runInNewContext('(segment, message, language = "zh-CN") => { const item={dataset:{}},toggle={},detail={},appState={language}; const isChineseLanguage = value => String(value).startsWith("zh"); ' + app.slice(statusBegin,statusEnd) + ' ' + app.slice(titleBegin,titleEnd) + ' ' + app.slice(detailBegin,detailEnd) + ' return {status:item.dataset.status,title:toggle.textContent,detail:detail.textContent}; }', {}, {timeout:2000});
  const originalDetail = '工具调用进行中';
  const historical = normalize({kind:'tool',status:'running',title:originalDetail,detail:originalDetail}, {});
  check(historical.status, 'unknown', 'Missing historical completion pretends to run');
  check(historical.title.includes('历史状态未保存'), true, 'Legacy trace uncertainty concealed');
  check(historical.detail.startsWith('历史记录未保存工具的最终结果，无法确认执行状态。'), true, 'Expanded historical card still implies current execution');
  check(historical.detail.includes('当时记录：' + originalDetail), true, 'Original historical evidence lost');
  check(normalize({kind:'search',status:'running',title:'Searching',detail:'Searching'}, {}, 'en').detail.includes('Recorded at the time: Searching'), true, 'English history loses the original observation');
  check(normalize({kind:'tool',status:'running',title:'Tool'}, {}, 'en').detail.includes('its execution status cannot be confirmed.'), true, 'English history uncertainty is missing');
  check(normalize({kind:'tool',status:'running',detail:'   '}, {}).detail.includes('当时记录'), false, 'Blank history gains a fabricated observation');
  const active = normalize({kind:'tool',status:'running',title:'Tool',detail:originalDetail}, {is_live_stream:true});
  check(active.status, 'running', 'Active operation disguised as history');
  check(active.detail, originalDetail, 'Active detail changed by historical fallback');
  const complete = normalize({kind:'tool',status:'done',title:'Done',detail:'  Successfully completed  '}, {});
  check(complete.status, 'done', 'Recorded successful history lost');
  check(complete.detail, '  Successfully completed  ', 'Recorded final result modified');
  check(normalize({kind:'tool',status:'failed',detail:'Failed: denied'}, {}).detail, 'Failed: denied', 'Recorded failure was concealed');
  check(normalize({kind:'tool',status:'running',detail:'<script>bad</script>'}, {}).detail.endsWith('当时记录：<script>bad</script>'), true, 'Historical evidence was changed instead of rendered as text');
}
console.log(`PASS: ${assertions} production remote/local tool history assertions`);
