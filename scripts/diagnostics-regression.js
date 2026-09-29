'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { createDiagnostics } = require('../public/diagnostics');
const { requestDiagnostics, audit } = require('../lib/request-diagnostics');
const { trace } = require('../lib/diagnostic-trace');
const canary = 'PRIVATE-CANARY-email@example.invalid-token-secret-file-name-message';
const uuid = crypto.randomUUID();
const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'diagnostics.js'), 'utf8');
assert.match(source, /version\s*=\s*'20260929-stream-r7'/, 'diagnostics resource must use the active build marker');
function create(options = {}) {
  let stored = options.saved || null, clock = 0;
  const env = { location: { href: options.href || 'https://rai.test/beta/' }, Request, Headers, TextDecoder,
    performance: { now: () => ++clock }, crypto: crypto.webcrypto,
    setTimeout: () => 1, sessionStorage: { getItem: () => stored, setItem: (_key, value) => { stored = value; } }, ...options.env };
  return { diagnostics: createDiagnostics(env), env, stored: () => stored };
}
function response(text, headers = {}) { return new Response(text, { headers: { 'Content-Type': 'text/event-stream', ...headers } }); }
async function drain(reader) { const chunks = []; for (;;) { const item = await reader.read(); if (item.done) break; chunks.push(item.value); } return Buffer.concat(chunks).toString('utf8'); }
async function main() {
  const h = create(); let called, calls = 0;
  const original = response('unread-body', { 'X-RAI-Diagnostic-Id': uuid, 'X-Request-ID': 'req_1790650000000_0123456789abcdef' });
  const baseFetch = async (resource, init) => { called = { resource, init }; calls++; return original; };
  const fetchWrapped = h.diagnostics.wrapFetch(baseFetch, () => '/beta/api');
  const init = { method: 'POST', credentials: 'omit', redirect: 'error', headers: { Authorization: canary }, body: canary, signal: new AbortController().signal };
  const returned = await fetchWrapped('/beta/api/auth/qr/confirm', init);
  assert.equal(returned, original); assert.equal(original.bodyUsed, false); assert.equal(calls, 1);
  assert.equal(called.init.body, init.body); assert.equal(called.init.signal, init.signal); assert.equal(called.init.credentials, 'omit'); assert.equal(called.init.redirect, 'error');
  assert.equal(called.init.headers.get('Authorization'), canary); assert.match(called.init.headers.get('X-RAI-Client-Request-Id'), /^[a-f0-9-]{36}$/);
  assert.equal(init.headers['X-RAI-Client-Request-Id'], undefined, 'caller headers untouched');
  const report = h.diagnostics.report(); assert.equal(report.events.at(-1).serverRequestId, uuid); assert.equal(report.events.at(-1).endpoint, 'auth');
  assert.ok(!JSON.stringify(report).includes(canary)); assert.ok(!h.stored().includes(canary));
  for (const url of ['https://other.test/beta/api/chat', 'https://rai.test/api/chat', 'https://rai.test/beta/api-evil/chat']) {
    await fetchWrapped(url, init); assert.equal(called.init, init, 'outside API origin/path is transparent, no tracking header');
  }
  const request = new Request('https://rai.test/beta/api/chat/stream', { method: 'POST', body: canary, headers: { Authorization: canary } });
  await fetchWrapped(request); assert.equal(request.bodyUsed, false); assert.equal(request.headers.get('X-RAI-Client-Request-Id'), null); assert.equal(called.resource, request);
  const failure = new Error(canary), failing = h.diagnostics.wrapFetch(async () => { throw failure; }, () => '/beta/api');
  await assert.rejects(() => failing('/beta/api/chat'), error => error === failure);
  const abort = new DOMException(canary, 'AbortError');
  await assert.rejects(() => h.diagnostics.wrapFetch(async () => { throw abort; }, () => '/beta/api')('/beta/api/chat'), error => error === abort);
  assert.equal(h.diagnostics.report().events.at(-1).action, 'cancelled');
  const normal = 'data: '+JSON.stringify({type:'model_info',model:'deepseek-flash'})+'\n\ndata: '+JSON.stringify({type:'reasoning',content:canary})+'\n\ndata: '+JSON.stringify({type:'content',content:'你好'})+'\n\ndata: '+JSON.stringify({type:'usage',usage:{prompt_tokens:20,completion_tokens:2,prompt_cache_hit_tokens:15}})+'\n\ndata: {"type":"done"}\n\n';
  const streamResponse = response(normal); assert.equal(await drain(h.diagnostics.reader(streamResponse)), normal);
  let summary = h.diagnostics.report().events.at(-1); assert.equal(summary.category, 'stream'); assert.equal(summary.action, 'completed'); assert.equal(summary.model, 'deepseek-flash'); assert.equal(summary.cachedTokens, 15); assert.equal(summary.contentChars, 2); assert.equal(summary.reasoningChars, canary.length);
  for (const [text, outcome] of [['data: {"type":"reasoning","content":"thought"}\n\ndata: {"type":"done"}\n\n','incomplete'],['data: {"type":"content","content":"partial"}\n\n','incomplete'],['data: {"type":"cancelled"}\n\n','cancelled'],['data: {"type":"error","message":"'+canary+'"}\n\n','error']]) {
    assert.equal(await drain(h.diagnostics.reader(response(text))), text); assert.equal(h.diagnostics.report().events.at(-1).action, outcome);
  }
  const upstream = 'data: '+JSON.stringify({choices:[{delta:{content:'正文',reasoning_content:'思考'}}]})+'\n\ndata: [DONE]\n\n';
  const bytes = new TextEncoder().encode(upstream); let pos = 0;
  const fragmented = new Response(new ReadableStream({pull(controller){if(pos===bytes.length)controller.close();else controller.enqueue(bytes.slice(pos,++pos));}}));
  assert.equal(await drain(h.diagnostics.reader(fragmented)), upstream); summary = h.diagnostics.report().events.at(-1); assert.equal(summary.contentChars,2); assert.equal(summary.reasoningChars,2); assert.equal(summary.action,'completed');
  let reason;
  const cancelling = h.diagnostics.reader(new Response(new ReadableStream({cancel(value){reason=value;}}))); await cancelling.cancel(canary); assert.equal(reason,canary); assert.equal(h.diagnostics.report().events.at(-1).action,'cancelled');
  const broken = h.diagnostics.reader(new Response(new ReadableStream({pull(controller){controller.error(failure);}}))); await assert.rejects(()=>broken.read(),e=>e===failure); assert.equal(h.diagnostics.report().events.at(-1).action,'error');
  const huge='data: '+JSON.stringify({type:'tool_status',content:'x'.repeat(300000)})+'\n\ndata: {"type":"done"}\n\n';
  assert.equal(await drain(h.diagnostics.reader(response(huge))),huge);assert.equal(h.diagnostics.report().events.at(-1).skippedEvents,1);
  for(let i=0;i<260;i++)await fetchWrapped('/beta/api/files/'+canary);
  assert.equal(h.diagnostics.report().events.length,500);assert.ok(h.diagnostics.report().dropped>0);assert.ok(!JSON.stringify(h.diagnostics.report()).includes(canary));
  const poisoned=create({saved:JSON.stringify([{time:new Date().toISOString(),category:canary,action:canary,model:canary,clientRequestId:canary,url:canary,body:canary,contentChars:canary}])});assert.ok(!JSON.stringify(poisoned.diagnostics.report()).includes(canary));
  const noStorage=create({env:{sessionStorage:{getItem(){throw failure;},setItem(){throw failure;}}}}); await noStorage.diagnostics.wrapFetch(baseFetch,()=>'/beta/api')('/beta/api/chat');assert.equal(noStorage.diagnostics.report().events.length,2);
  assert.deepEqual(trace({headers:{'x-rai-client-request-id':canary},diagnosticRequestId:canary,diagnosticChatRequestId:canary,method:canary,route:{path:'/api/'+canary}}, {model:canary}), {serverRequestId:undefined,clientRequestId:undefined,chatRequestId:undefined,method:'other',endpoint:'other',model:'other',mode:undefined});
  // Real HTTP: client UUID -> middleware UUID -> canonical chat/model event -> original Response.
  const app=express(), logs=[], output=console.info; let server;
  console.info = value => logs.push(JSON.parse(value));
  try {
    app.use(requestDiagnostics);app.post('/api/chat/stream',(req,res)=>{req.diagnosticChatRequestId='req_1790650000000_0123456789abcdef';res.setHeader('X-Request-ID',req.diagnosticChatRequestId);audit('chat_route',{model:'deepseek-flash',mode:'chat',body:canary},req);res.type('text/event-stream').send(normal);});
    server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));}); const origin='http://127.0.0.1:'+server.address().port;
    const live=create({href:origin+'/'}), result=await live.diagnostics.wrapFetch(fetch,()=>'/api')(origin+'/api/chat/stream',{method:'POST'}); await drain(live.diagnostics.reader(result));
    const client=live.diagnostics.report().events.find(e=>e.category==='stream'),route=logs.find(e=>e.event==='chat_route');
    assert.equal(client.serverRequestId,route.trace.serverRequestId);assert.equal(client.clientRequestId,route.trace.clientRequestId);assert.equal(client.chatRequestId,route.trace.chatRequestId);assert.equal(route.trace.model,'deepseek-flash');assert.equal(client.model,'deepseek-flash');
    audit(canary,{model:canary,requestId:canary});assert.ok(!JSON.stringify(logs).includes(canary));
  } finally {console.info=output;if(server)await new Promise(resolve=>server.close(resolve));}
  console.log('diagnostics PASS: real HTTP request correlation, exact model, byte/Response identity, no read-ahead/retry, cancel/error propagation, EOF vs DONE, fragmented Unicode/upstream SSE, bounded buffers/storage, hostile persisted canary filtering, local-only export data');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
