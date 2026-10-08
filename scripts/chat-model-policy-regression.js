'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sqlite3 = require('sqlite3');
const { CHAT_MODEL_IDS, CHAT_MODEL_LIMITS, CHAT_MODEL_WINDOW_MS, activeTier, createChatModelQuotaService } = require('../lib/chat-model-policy');
const { estimateContextTokens, enforceContextWindow, CONTEXT_WINDOW_TOKENS, CONTEXT_SAFETY_TOKENS } = require('../lib/context-window');
const { applyChatReasoningPolicy } = require('../lib/chat-reasoning-policy');
const { createDeepSeekProviderFetch } = require('../lib/deepseek-provider-fallback');
async function main() {
    assert.deepEqual(CHAT_MODEL_IDS, ['deepseek-v4.1-flash','gpt-6.1-sol','gpt-6-luna','gpt-6-astra']);
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
    for(const id of ['gpt-6.1-sol','gpt-6-luna']){await quota.reserve(2,'research',id);await quota.reserve(2,'research',id);}
    await quota.settle(2,'research',['gpt-6.1-sol','gpt-6-luna','gpt-6-luna']);
    assert.equal((await get("SELECT count(*) AS n FROM chat_model_turns WHERE request_id='research' AND status='completed'")).n,2);
    await new Promise((resolve,reject)=>db.close(e=>e?reject(e):resolve()));
    for(const id of CHAT_MODEL_IDS){
        for(const profile of ['low','medium','high','mixed']){
            const body=applyChatReasoningPolicy({model:id},{thinkingMode:true,profile});
            assert.equal(body.reasoning_effort,profile==='mixed'?undefined:profile);
        }
        const off=applyChatReasoningPolicy({model:id},{thinkingMode:false,profile:'high'});
        assert.equal(off.reasoning_effort,id.startsWith('gpt')?'low':undefined);
        if(id.startsWith('deepseek'))assert.equal(off.thinking.type,'disabled');
    }
    const original = { model:'gpt-6-astra',max_tokens:8000,messages:[{role:'system',content:'SYSTEM_INTACT'},...Array.from({length:22},(_,i)=>({role:i%2?'assistant':'user',content:'history-'+i+' '+ '中'.repeat(8000)})),{role:'user',content:'LATEST_QUESTION'},{role:'assistant',content:null,tool_calls:[{id:'tool_1',type:'function',function:{name:'read_file',arguments:'{}'}}]},{role:'tool',tool_call_id:'tool_1',content:'LATEST_TOOL_RESULT'}]};
    const snapshot=JSON.stringify(original);let notices=0, chunks=0;
    const compressed=await enforceContextWindow(original,{summarize:async text=>{chunks++;assert.ok(text.length<=24000);return 'Facts and pending task summary.';},onCompressed:()=>notices++});
    assert.equal(JSON.stringify(original),snapshot,'must not mutate persisted history');assert.equal(notices,1);assert.ok(chunks>1);
    assert.equal(compressed.messages[0].content,'SYSTEM_INTACT');assert.ok(compressed.messages.some(m=>m.content==='LATEST_QUESTION'));assert.ok(compressed.messages.some(m=>m.tool_call_id==='tool_1'));
    assert.ok(estimateContextTokens(compressed)+8000+CONTEXT_SAFETY_TOKENS<=CONTEXT_WINDOW_TOKENS);
    await assert.rejects(enforceContextWindow({messages:[{role:'user',content:'x'.repeat(300000)}]}, {summarize:async()=>''}),e=>e.code==='current_turn_context_too_large');
    await assert.rejects(enforceContextWindow(original,{summarize:async()=>''}),e=>e.code==='context_compression_failed');
    const vision={messages:[{role:'user',content:[{type:'text',text:'Look'},{type:'image_url',image_url:{url:'data:image/png;base64,abc'}}]}]};assert.ok(estimateContextTokens(vision)>=16384);
    let calls=[];
    const provider=createDeepSeekProviderFetch({primaryUrl:'https://fast.test/v1/chat/completions',primaryKey:'private-test',officialUrl:'https://official.test/v1/chat/completions',officialKey:'official-test',fetchImpl:async(url,options)=>{calls.push({url,options});return calls.length===1?new Response('down',{status:503}):new Response('{}',{status:200});}});
    const response=await provider('https://fast.test/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer private-test'},body:JSON.stringify({model:'deepseek-v4.1-flash',thinking:{type:'enabled'},reasoning_effort:'low'})});
    assert.equal(response.status,200);assert.equal(calls.length,2);assert.equal(calls[1].url,'https://official.test/v1/chat/completions');assert.equal(new Headers(calls[1].options.headers).get('Authorization'),'Bearer official-test');assert.equal(JSON.parse(calls[1].options.body).model,'deepseek-flash');assert.equal(JSON.parse(calls[1].options.body).reasoning_effort,'high');
    calls=[];const cancel=new AbortController();cancel.abort();await assert.rejects(provider('https://fast.test/v1/chat/completions',{signal:cancel.signal,body:JSON.stringify({model:'deepseek-v4.1-flash'})}));assert.equal(calls.length,0);
    const server=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');const app=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');const html=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');
    for(const id of CHAT_MODEL_IDS){assert.ok(html.includes('data-model="'+id+'"'));assert.ok(app.includes("'"+id+"': {"));}
    for(const id of ['claude-sonnet-5','gemini-3.6-flash-low','nemotron-3-ultra','gpt-image-2','kolors-free'])assert.ok(!html.includes('data-model="'+id+'"'));
    assert.match(server,/await settleChatModelTurn\(!streamDegraded/);assert.match(server,/chatModelQuotaContext.run/);assert.match(server,/const ADMIN_MODEL_CATALOG = \[\.\.\.CHAT_MODEL_CATALOG\]/);assert.match(app,/3, 50, 80/);assert.match(app,/50, 100, 200/);assert.match(app,/100, 200, 500/);
    console.log('chat_model_policy_regression_ok: rolling quota, concurrency, expiry, cancellation, idempotency, research, thinking tiers, 256k compression, vision preservation and provider fallback');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
