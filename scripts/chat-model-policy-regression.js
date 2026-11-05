'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sqlite3 = require('sqlite3');
const { CHAT_MODEL_IDS, CHAT_MODEL_LIMITS, CHAT_MODEL_WINDOW_MS, activeTier, createChatModelQuotaService } = require('../lib/chat-model-policy');
const { estimateContextTokens, enforceContextWindow, CONTEXT_WINDOW_TOKENS, CONTEXT_SAFETY_TOKENS } = require('../lib/context-window');
const { applyChatReasoningPolicy } = require('../lib/chat-reasoning-policy');
const { createDeepSeekProviderFetch } = require('../lib/deepseek-provider-fallback');
async function main() {
    assert.deepEqual(CHAT_MODEL_IDS, ['deepseek-v4.1-flash','gpt-6.1-sol','gpt-6-luna','gpt-6-astra']);
    assert.deepEqual(require('../lib/chat-model-policy').CHAT_MODEL_CATALOG.map(x => x.thinkingProfiles), [['auto','high','max'], ['auto','low','medium','high','xhigh','max'], ['auto','low','medium','high','xhigh','max'], ['auto','low','medium','high','xhigh','max']]);
    assert.deepEqual(Object.values(CHAT_MODEL_LIMITS).map(x => [x['gpt-6-astra'],x['gpt-6.1-sol'],x['gpt-6-luna']]), [[3,50,100],[50,100,200],[80,200,500]]);
    const db = await new Promise((resolve,reject) => { const connection = new sqlite3.Database(':memory:', e => e ? reject(e) : resolve(connection)); });
    const run = (sql, params=[]) => new Promise((resolve,reject) => db.run(sql, params, function(e){e?reject(e):resolve({changes:this.changes})}));
    const get = (sql, params=[]) => new Promise((resolve,reject) => db.get(sql, params, (e,row)=>e?reject(e):resolve(row)));
    const all = (sql, params=[]) => new Promise((resolve,reject) => db.all(sql, params, (e,rows)=>e?reject(e):resolve(rows)));
    let tail = Promise.resolve(), clock = Date.UTC(2026,9,8);
    const withTransaction = operation => { const current=tail.then(async()=>{await run('BEGIN IMMEDIATE');try{const result=await operation({run,get,all});await run('COMMIT');return result;}catch(e){await run('ROLLBACK');throw e;}});tail=current.catch(()=>{});return current; };
    const quota = createChatModelQuotaService({withTransaction,now:()=>clock});
    await run('CREATE TABLE users(id INTEGER PRIMARY KEY, membership TEXT, membership_end TEXT)');
    await run("INSERT INTO users VALUES (1,'free',NULL),(2,'pro',?),(3,'max',?),(4,'max',?)", [new Date(clock+1e9).toISOString(),new Date(clock+1e9).toISOString(),new Date(clock-1).toISOString()]);
    assert.equal(activeTier({membership:'max',membership_end:new Date(clock-1).toISOString()},clock),'free');
    assert.equal(await quota.reserve(1,'ds','deepseek-v4.1-flash'), null);
    let reservation = await quota.reserve(1,'cancel','gpt-6-astra');assert.equal(reservation.remaining,2);
    await quota.settle(1,'cancel',[]);assert.equal((await get("SELECT count(*) AS n FROM chat_model_turns WHERE status='completed'")).n,0);
    const concurrent = await Promise.allSettled(Array.from({length:6},(_,i)=>quota.reserve(1,'parallel-'+i,'gpt-6-astra')));
    assert.equal(concurrent.filter(r=>r.status==='fulfilled').length,3,'concurrent reservations cannot overrun cap');
    assert.equal(concurrent.filter(r=>r.status==='rejected' && r.reason.code==='model_chat_quota_exceeded').length,3);
    await quota.settle(1,'parallel-0',['gpt-6-astra']);await quota.settle(1,'parallel-0',['gpt-6-astra']);
    assert.equal((await get("SELECT count(*) AS n FROM chat_model_turns WHERE status='completed'")).n,1,'completion idempotency');
    clock+=16*60*1000;await quota.reserve(1,'after-crash','gpt-6-astra');await quota.settle(1,'after-crash',[]);
    clock+=CHAT_MODEL_WINDOW_MS;const reset=await quota.reserve(1,'after-window','gpt-6-astra');assert.equal(reset.remaining,2,'exact rolling boundary releases completed turn');await quota.settle(1,'after-window',[]);
    for(const [user,tier] of [[2,'pro'],[3,'max'],[4,'free']]){
        const row=await quota.reserve(user,'membership','gpt-6.1-sol');assert.equal(row.limit,CHAT_MODEL_LIMITS[tier]['gpt-6.1-sol']);await quota.settle(user,'membership',[]);
    }
    // At most one count per GPT used in a successful research turn, regardless of tool loops.
    for(const id of ['gpt-6.1-sol','gpt-6-astra']){await quota.reserve(2,'research',id);await quota.reserve(2,'research',id);}
    await quota.settle(2,'research',['gpt-6.1-sol','gpt-6-astra','gpt-6-astra']);
    assert.equal((await get("SELECT count(*) AS n FROM chat_model_turns WHERE request_id='research' AND status='completed'")).n,2);
    await new Promise((resolve,reject)=>db.close(e=>e?reject(e):resolve()));
    for(const id of CHAT_MODEL_IDS){
        for(const profile of ['low','medium','high','max']){
            const body=applyChatReasoningPolicy({model:id},{thinkingMode:true,profile});
            assert.equal(body.reasoning_effort,profile);
        }
        const adaptive=applyChatReasoningPolicy({model:id,reasoning_effort:'high'},{thinkingMode:true,profile:'auto'});
        assert.equal(Object.hasOwn(adaptive,'reasoning_effort'),false,'Adaptive delegates effort to provider/model');
        if(id.startsWith('deepseek'))assert.equal(adaptive.thinking.type,'enabled');
        const defaultThinking=applyChatReasoningPolicy({model:id},{thinkingMode:true});
        assert.equal(Object.hasOwn(defaultThinking,'reasoning_effort'),false,'Thinking defaults to Adaptive');
        const off=applyChatReasoningPolicy({model:id},{thinkingMode:false,profile:'high'});
        assert.equal(off.reasoning_effort,id.startsWith('gpt')?'low':undefined);
        if(id.startsWith('deepseek'))assert.equal(off.thinking.type,'disabled');
    }
    let softSkipped=0; const softBody={model:'gpt-6.1-sol',max_tokens:8000,messages:[{role:'user',content:'x'.repeat(245000)}]};
    const softResult=await enforceContextWindow(softBody,{summarize:async()=>{throw Object.assign(new Error('test'),{code:'context_compression_failed'});},onDiagnostic:event=>{assert.equal(event.estimated,true);softSkipped++;}});
    assert.equal(softResult,softBody,'compression threshold is soft while hard output/context reserve remains available');assert.equal(softSkipped,1);
    const original = { model:'gpt-6-astra',max_tokens:8000,messages:[{role:'system',content:'SYSTEM_INTACT'},...Array.from({length:22},(_,i)=>({role:i%2?'assistant':'user',content:'history-'+i+' '+ '中'.repeat(8000)})),{role:'user',content:'LATEST_QUESTION'},{role:'assistant',content:null,tool_calls:[{id:'tool_1',type:'function',function:{name:'read_file',arguments:'{}'}}]},{role:'tool',tool_call_id:'tool_1',content:'LATEST_TOOL_RESULT'}]};
    const snapshot=JSON.stringify(original);let notices=0, chunks=0;
    const compressed=await enforceContextWindow(original,{summarize:async text=>{chunks++;assert.ok(text.length<=24000);return 'Facts and pending task summary.';},onCompressed:()=>notices++});
    assert.equal(JSON.stringify(original),snapshot,'must not mutate persisted history');assert.equal(notices,1);assert.ok(chunks>1);
    assert.equal(compressed.messages[0].content,'SYSTEM_INTACT');assert.ok(compressed.messages.some(m=>m.content==='LATEST_QUESTION'));assert.ok(compressed.messages.some(m=>m.tool_call_id==='tool_1'));
    assert.ok(estimateContextTokens(compressed)+8000+CONTEXT_SAFETY_TOKENS<=CONTEXT_WINDOW_TOKENS);
    // A few large file/command results can fill the budget before six exchanges exist.
    for (const [count, resultSize] of [[2,150000],[5,65000],[7,70000]]) {
        const messages = [{role:'system',content:'STABLE_POLICY'}, {role:'user',content:'Finish report.pptx; keep the original image.'}, {role:'user',content:'[Enabled client skill directory] documents, presentations'}];
        for (let step=1; step<=count; step++) messages.push(
            {role:'assistant',content:null,tool_calls:[{id:`large_${step}`,type:'function',function:{name:'read_code',arguments:JSON.stringify({path:'report.pptx',offset:step})}}]},
            {role:'tool',tool_call_id:`large_${step}`,content:`CHECKPOINT=${step}\n`+'x'.repeat(resultSize)});
        const body = {model:'gpt-6-luna',max_tokens:8000,messages};
        const source = JSON.stringify(body); let compressedEvents=0, summarized='';
        const result = await enforceContextWindow(body, {summarize:async text=>{summarized+=text; return 'Completed older report.pptx steps. Continue from the latest checkpoint; do not replay writes.';},onCompressed:()=>compressedEvents++});
        assert.equal(JSON.stringify(body),source,'large-turn compaction never edits the original transcript');
        assert.equal(compressedEvents,1);
        assert.deepEqual(result.messages.at(-1),messages.at(-1),'the latest complete tool result remains intact');
        assert.ok(result.messages.some(message=>message.content===messages[1].content),'retain the original task');
        assert.ok(result.messages.some(message=>message.content===messages[2].content),'consecutive skill metadata belongs to the same current task');
        assert.ok(summarized.includes('CHECKPOINT=1'),'older results enter the summary rather than disappearing');
        const ids = new Set(result.messages.flatMap(message=>(message.tool_calls||[]).map(call=>call.id)));
        for (const message of result.messages.filter(message=>message.role==='tool')) assert.ok(ids.has(message.tool_call_id),'large-turn compaction never orphans a tool result');
        assert.ok(estimateContextTokens(result)+8000+CONTEXT_SAFETY_TOKENS<=CONTEXT_WINDOW_TOKENS);
    }
    await assert.rejects(enforceContextWindow({messages:[{role:'user',content:'x'.repeat(300000)}]}, {summarize:async()=>''}),e=>e.code==='current_turn_context_too_large');
    await assert.rejects(enforceContextWindow(original,{summarize:async()=>''}),e=>e.code==='context_compression_failed');
    const vision={messages:[{role:'user',content:[{type:'text',text:'Look'},{type:'image_url',image_url:{url:'data:image/png;base64,abc'}}]}]};assert.ok(estimateContextTokens(vision)>=16384);
    let calls=[];
    const provider=createDeepSeekProviderFetch({primaryUrl:'https://fast.test/v1/chat/completions',primaryKey:'private-test',officialUrl:'https://official.test/v1/chat/completions',officialKey:'official-test',fetchImpl:async(url,options)=>{calls.push({url,options});return calls.length===1?new Response('down',{status:503}):new Response('{}',{status:200});}});
    const response=await provider('https://fast.test/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer private-test'},body:JSON.stringify({model:'deepseek-v4.1-flash',thinking:{type:'enabled'},reasoning_effort:'low'})});
    assert.equal(response.status,200);assert.equal(calls.length,2);assert.equal(calls[1].url,'https://official.test/v1/chat/completions');assert.equal(new Headers(calls[1].options.headers).get('Authorization'),'Bearer official-test');assert.equal(JSON.parse(calls[1].options.body).model,'deepseek-flash');assert.equal(JSON.parse(calls[1].options.body).reasoning_effort,'high');
    calls=[];const cancel=new AbortController();cancel.abort();await assert.rejects(provider('https://fast.test/v1/chat/completions',{signal:cancel.signal,body:JSON.stringify({model:'deepseek-v4.1-flash'})}));assert.equal(calls.length,0);
    // HTTP headers / keepalive are not a model response. Sol timeout goes DIRECTLY official.
    let timeoutCalls=[];
    const timeoutProvider=createDeepSeekProviderFetch({primaryUrl:'https://fast.test/v1/chat/completions',primaryKey:'sol-test',primaryModels:['gpt-6.1-sol'],officialUrl:'https://official.test/v1/chat/completions',officialKey:'official-test',primaryTimeoutMs:25,fetchImpl:async(url,options)=>{
        timeoutCalls.push({url,options});
        return url.includes('fast.test') ? new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(': keepalive\n\n'));}}),{headers:{'Content-Type':'text/event-stream'}}) : new Response('data: {"choices":[{"delta":{"content":"official answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    }});
    const timeoutResponse=await timeoutProvider('https://fast.test/v1/chat/completions',{raiThinkingMode:false,body:JSON.stringify({model:'gpt-6.1-sol',stream:true,reasoning_effort:'low',messages:[{role:'user',content:'tiny prompt'}]})});
    assert.equal(timeoutCalls.length,2);assert.equal(timeoutResponse.raiOfficialFallback,true);assert.equal(JSON.parse(timeoutCalls[1].options.body).thinking.type,'disabled');assert.match(await timeoutResponse.text(),/official answer/);
    timeoutCalls=[];
    const adaptiveFallback=await timeoutProvider('https://fast.test/v1/chat/completions',{raiThinkingMode:true,body:JSON.stringify({model:'gpt-6.1-sol',stream:true,messages:[{role:'user',content:'tiny adaptive prompt'}]})});
    assert.equal(adaptiveFallback.raiOfficialFallback,true);
    assert.equal(JSON.parse(timeoutCalls[1].options.body).thinking.type,'enabled');
    assert.equal(Object.hasOwn(JSON.parse(timeoutCalls[1].options.body),'reasoning_effort'),false,'Adaptive fallback remains model-managed');
    let deliveredCalls=0;
    const deliveredProvider=createDeepSeekProviderFetch({primaryUrl:'https://fast.test/v1/chat/completions',primaryKey:'private-test',officialUrl:'https://official.test/v1/chat/completions',officialKey:'official-test',primaryTimeoutMs:25,fetchImpl:async()=>{deliveredCalls++;return new Response('data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\ndata: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');}});
    const delivered=await deliveredProvider('https://fast.test/v1/chat/completions',{body:JSON.stringify({model:'deepseek-v4.1-flash',stream:true})});
    assert.match(await delivered.text(),/thinking/);assert.equal(deliveredCalls,1,'effective reasoning delta must prevent fallback/replay');
    const server=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');const app=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');const html=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');
    for(const id of CHAT_MODEL_IDS){assert.ok(html.includes('data-model="'+id+'"'));assert.ok(app.includes("'"+id+"': {"));}
    for(const id of ['claude-sonnet-5','gemini-3.6-flash-low','nemotron-3-ultra','gpt-image-2','kolors-free'])assert.ok(!html.includes('data-model="'+id+'"'));
    assert.match(server,/await settleChatModelTurn\(!streamDegraded/);assert.match(server,/chatModelQuotaContext.run/);assert.match(server,/const ADMIN_MODEL_CATALOG = \[\.\.\.CHAT_MODEL_CATALOG\]/);assert.match(app,/3, 50, 80/);assert.match(app,/50, 100, 200/);
    // First effective token (content or reasoning) deadline is 20s by default, and
    // long thinking must not be mistaken for a stalled provider.
    assert.match(server, /RAI_CHAT_FIRST_TOKEN_TIMEOUT_MS\) \|\| '20000'/);
    assert.match(server, /CHAT_PROVIDER_FIRST_TOKEN_TIMEOUT_MS/);
    assert.match(server, /20 秒内无首字或服务失败/);
    // Reasoning-only streams are recovered into a real answer instead of being marked truncated.
    assert.match(server, /reasoning-only recovery failed/);
    assert.match(server, /Return only the final user-facing answer as normal assistant content/);
    // A transient refresh failure must not clear a still-valid refresh cookie.
    assert.match(server, /terminalCodes\.has\(error\?\.code\)/);
    assert.match(server, /res\.status\(503\)\.json\(\{ success: false, error: '会话刷新暂时不可用，请重试' \}\)/);
    // Official history excludes reasoning; custom providers retain their tool protocol.
    const historyBuilder = app.slice(app.indexOf('function buildContextMessagesFromState'), app.indexOf('async function markMessageAsRegeneratedPrevious'));
    assert.ok(historyBuilder.length > 0, 'buildContextMessagesFromState must exist');
    const historyContext = { appState: { customApiMode: false }, isRegeneratedPreviousReply: () => false };
    vm.createContext(historyContext); vm.runInContext(historyBuilder, historyContext);
    const sourceHistory = [{role:'assistant',content:'answer',reasoning_content:'thinking',tool_calls:[{id:'call-1',name:'read_file',arguments:'{}'}]},
        {role:'tool',content:'result',tool_call_id:'call-1'}];
    const officialHistory = historyContext.buildContextMessagesFromState(sourceHistory);
    assert.equal(officialHistory[0].reasoning_content, undefined, 'official model must not receive stored reasoning');
    assert.equal(officialHistory[0].tool_calls, undefined, 'official model must not receive custom provider tool calls');
    assert.equal(officialHistory[1].tool_call_id, undefined);
    historyContext.appState.customApiMode = true;
    const customHistory = historyContext.buildContextMessagesFromState(sourceHistory);
    assert.equal(customHistory[0].reasoning_content, 'thinking');
    assert.equal(customHistory[0].tool_calls[0].function.name, 'read_file');
    assert.equal(customHistory[1].tool_call_id, 'call-1', 'restored custom tool result must remain paired with its call');
    console.log('chat_model_policy_regression_ok: rolling quota, concurrency, expiry, cancellation, idempotency, research, thinking tiers, 256k compression, vision preservation and provider fallback');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
