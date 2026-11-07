'use strict';
const assert = require('node:assert/strict');
const { createGptPrimaryFetch } = require('../lib/gpt-provider-fallback');
const { createDeepSeekProviderFetch } = require('../lib/deepseek-provider-fallback');
const { createChatLatencyTrace, fetchWithLatency } = require('../lib/chat-latency');
const { MAX_STREAM_RETRIES, canRetryStream, buildStreamRetryBody } = require('../lib/chat-stream-retry');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const encode = value => new TextEncoder().encode(value);
const sse = delta => 'data: '+JSON.stringify({ choices: [{ delta }] })+'\n\n';
const primaryUrl = 'https://primary.test/v1/chat/completions', fallbackUrl = 'https://fast.test/v1/chat/completions';
const options = (thinking = true, signal) => ({ signal, raiThinkingMode: thinking, headers: { Authorization: 'Bearer fast-fixture' }, body: JSON.stringify({ model: 'gpt-6.1-sol', stream: true, reasoning_effort: 'low', messages: [{ role: 'user', content: 'fixture' }] }) });

async function main() {
    for (const preamble of [': keepalive\n\n',sse({role:'assistant'}),sse({content:' '}),'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',sse({tool_calls:[{index:0,function:{name:'read_file'}}]})]) {
        const events = [];
        const primary = createGptPrimaryFetch({ primaryUrl, primaryKey:'primary-fixture',fallbackUrl,firstTokenTimeoutMs:15,
            fetchImpl:async (_url,opts) => {
                opts.signal.addEventListener('abort',()=>events.push('aborted'));
                return new Response(new ReadableStream({start(c){c.enqueue(encode(preamble));},async cancel(){events.push('cancelling');await delay(5);events.push('cancelled');}}));
            },fallbackFetch:async()=>{events.push('fallback');return new Response(sse({content:'fast answer'})+'data: [DONE]\n\n');} });
        const response = await primary(fallbackUrl,options());
        assert.equal(response.raiProvider,'fast');assert.equal(response.raiMirroriumFallback,true);
        assert.match(await response.text(),/fast answer/);
        assert.ok(events.indexOf('aborted')<events.indexOf('fallback'),events.join(','));
        assert.ok(events.indexOf('cancelled')<events.indexOf('fallback'),events.join(','));
    }
    for (const mode of ['http_error','sse_error','empty']) {
        const events=[];
        const primary=createGptPrimaryFetch({primaryUrl,primaryKey:'primary-fixture',fallbackUrl,firstTokenTimeoutMs:50,
            fetchImpl:async(_url,opts)=>{opts.signal.addEventListener('abort',()=>events.push('aborted'));return new Response(mode==='http_error'?'rejected':mode==='sse_error'?'data: {"error":{"message":"private upstream failure"}}\n\n':'data: [DONE]\n\n',{status:mode==='http_error'?502:200});},
            fallbackFetch:async()=>{events.push('fallback');return new Response(sse({content:'ok'}));}});
        assert.equal((await primary(fallbackUrl,options())).raiMirroriumFallback,true);
        assert.deepEqual(events,['aborted','fallback']);
    }
    for (const thinking of [false,true]) {
        let release, fallbackCalls=0;
        const primary=createGptPrimaryFetch({primaryUrl,primaryKey:'primary-fixture',fallbackUrl,firstTokenTimeoutMs:20,
            fetchImpl:async(_url,opts)=>{assert.equal(new Headers(opts.headers).get('Authorization'),'Bearer primary-fixture');return new Response(new ReadableStream({start(c){c.enqueue(encode(sse({reasoning_content:'reasoning first'})));release=()=>{c.enqueue(encode(sse({content:'answer later'})+'data: [DONE]\n\n'));c.close();};}}));},
            fallbackFetch:async()=>{fallbackCalls++;return new Response(sse({content:'fast answer'}));}});
        const response=await primary(fallbackUrl,options(thinking));
        if (thinking) { assert.equal(response.raiProvider,'mirrorium');await delay(30);release();assert.match(await response.text(),/answer later/);assert.equal(fallbackCalls,0,'reasoning cancels first-token deadline when enabled'); }
        else { assert.equal(response.raiProvider,'fast');assert.equal(fallbackCalls,1,'reasoning cannot satisfy an off request deadline'); }
    }
    const original=sse({tool_calls:[{index:0,function:{name:'read_file',arguments:'{"path":'}}]})+sse({tool_calls:[{index:0,function:{arguments:'"x"}'}}]})+'data: [DONE]\n\n';
    let toolFallback=0;
    const tool=createGptPrimaryFetch({primaryUrl,primaryKey:'primary-fixture',fallbackUrl,fetchImpl:async()=>new Response(original),fallbackFetch:async()=>{toolFallback++;return new Response('');}});
    assert.equal(await(await tool(fallbackUrl,options())).text(),original);assert.equal(toolFallback,0,'real tool arguments are effective without replay');

    for (const timing of ['before','during']) {
        const controller=new AbortController();const reason=new Error('fixture cancellation');let fetchCalls=0,fallbackCalls=0;
        const primary=createGptPrimaryFetch({primaryUrl,primaryKey:'primary-fixture',fallbackUrl,firstTokenTimeoutMs:100,
            fetchImpl:async()=>{fetchCalls++;return new Response(new ReadableStream({start(c){c.enqueue(encode(': ping\n\n'));}}));},fallbackFetch:async()=>{fallbackCalls++;return new Response('');}});
        if(timing==='before')controller.abort(reason);else setTimeout(()=>controller.abort(reason),5);
        await assert.rejects(primary(fallbackUrl,options(true,controller.signal)),error=>error===reason);
        assert.equal(fallbackCalls,0);assert.equal(fetchCalls,timing==='before'?0:1);
    }
    // Observe raw headers before awaitFirstResponse, keep attempt IDs, and preserve provenance.
    let clock=0;const latency=createChatLatencyTrace({}, {write(){}}, {now:()=>clock});const call=latency.nextCall();
    const observed=async(url,opts)=>fetchWithLatency(async()=>{clock=3;return new Response(new ReadableStream({async start(c){await delay(10);clock=40;c.enqueue(encode(sse({content:'answer'})));c.close();}}));},url,opts,latency,{model:'gpt-6.1-sol',provider:'gpt_mirrorium',streaming:true,call});
    const primary=createGptPrimaryFetch({primaryUrl,primaryKey:'primary-fixture',fallbackUrl,fetchImpl:observed,fallbackFetch:async()=>{throw Error('must not retry');}});
    const success=await primary(fallbackUrl,options());assert.equal(success.raiProvider,'mirrorium');await success.text();
    const summary=latency.finish(false);assert.equal(summary.attempts[0].headers,3);assert.equal(summary.attempts[0].first_content,40);
    const provenance=new Response(sse({content:'official'}));Object.defineProperty(provenance,'raiOfficialFallback',{value:true});Object.defineProperty(provenance,'raiProvider',{value:'deepseek_official'});
    const retained=await fetchWithLatency(async()=>provenance,'x',{},createChatLatencyTrace({}, {write(){}}),{streaming:true});assert.equal(retained.raiOfficialFallback,true);assert.equal(retained.raiProvider,'deepseek_official');await retained.text();
    let count=0;const fast=createDeepSeekProviderFetch({primaryUrl:fallbackUrl,primaryKey:'fixture',officialUrl:'https://official.test',officialKey:'fixture2',primaryModels:['gpt-6.1-sol'],fetchImpl:async()=>++count===1?new Response('down',{status:502}):new Response(sse({content:'official'}))});
    const chain=createGptPrimaryFetch({primaryUrl,primaryKey:'fixture',fallbackUrl,fetchImpl:async()=>new Response('down',{status:502}),fallbackFetch:fast});
    const chainResult=await chain(fallbackUrl,options());assert.equal(chainResult.raiOfficialFallback,true);assert.equal(chainResult.raiMirroriumFallback,true);assert.equal(chainResult.raiProvider,'deepseek_official');

    const completedBody = { ...JSON.parse(options().body), messages: [
        { role: 'user', content: 'Finish the document' },
        { role: 'assistant', tool_calls: [{ id: 'completed-edit', type: 'function', function: { name: 'edit_file', arguments: '{"path":"fixture.txt"}' } }] },
        { role: 'tool', tool_call_id: 'completed-edit', content: 'The edit is complete' }
    ] };
    for (const failure of ['no_headers', 'timeout', 'network', 408, 429, 500, 502, 503, 504]) {
        let primaryCalls = 0, fallbackCalls = 0, billingCancelled = 0;
        const events = [];
        const recovering = createGptPrimaryFetch({ primaryUrl, primaryKey: 'fixture', fallbackUrl, firstTokenTimeoutMs: 15,
            fetchImpl: async (url, request) => {
                assert.equal(url, primaryUrl);
                const sent = JSON.parse(request.body);
                assert.equal(sent.model, 'gpt-6.1-sol');
                assert.deepEqual(sent.messages.filter(message => message.role === 'tool'), completedBody.messages.slice(-1));
                assert.equal(sent.messages.filter(message => message.tool_calls).length, 1);
                if (++primaryCalls > 1) return new Response(sse({ content: 'Original Sol continued.' }) + 'data: [DONE]\n\n');
                if (failure === 'network') throw Object.assign(new TypeError('PRIVATE_NETWORK_ERROR'), { cause: { code: 'ECONNRESET' } });
                if (failure === 'no_headers') return new Promise((resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }));
                if (failure === 'timeout') return new Response(new ReadableStream({ start(c) { c.enqueue(encode(': ping\n\n')); },
                    async cancel() { events.push('primary-cancelling'); await delay(5); events.push('primary-cancelled'); } }));
                return new Response(new ReadableStream({ cancel() { events.push('primary-cancelled'); } }), { status: failure });
            }, fallbackFetch: async () => {
                fallbackCalls++;
                if (!['network', 'no_headers'].includes(failure)) assert.equal(events.at(-1), 'primary-cancelled', 'release the failed primary reader before fallback');
                const rejected = new Response(new ReadableStream({ cancel() { billingCancelled++; } }), { status: 402 });
                Object.defineProperty(rejected, 'raiOfficialFallback', { value: true });
                return rejected;
            } });
        const request = { ...options(), body: JSON.stringify(buildStreamRetryBody(completedBody, 'Already generated. ')) };
        let rejected;
        try { await recovering(fallbackUrl, request); } catch (error) { rejected = error; }
        assert.ok(rejected, `${failure}: an exhausted fallback must expose the temporary original-GPT failure`);
        assert.equal(rejected.code, 'gpt_primary_temporarily_unavailable');
        assert.equal(rejected.status, 402);
        assert.doesNotMatch(rejected.message, /PRIVATE_/);
        assert.equal(canRetryStream(rejected, { attempt: 0, cancelled: false, remainingMs: 5000 }), true);
        const resumed = await recovering(fallbackUrl, request);
        assert.equal(resumed.raiProvider, 'mirrorium');
        assert.match(await resumed.text(), /Original Sol continued/);
        assert.equal(primaryCalls, 2);
        assert.equal(fallbackCalls, 1, 'a successful original-model stream must not be retried or fall back');
        assert.equal(billingCancelled, 1, 'release the rejected official response before retry');
        assert.equal(completedBody.messages.length, 3, 'completed tools remain authoritative without adding another tool call');
    }
    for (const stop of ['attempts', 'budget']) {
        let primaryCalls = 0, remainingMs = 5000;
        const unavailable = createGptPrimaryFetch({ primaryUrl, primaryKey: 'fixture', fallbackUrl,
            fetchImpl: async () => { primaryCalls++; return new Response('', { status: 503 }); },
            fallbackFetch: async () => {
                if (stop === 'budget') remainingMs = 0;
                const rejected = new Response('', { status: 402 });
                Object.defineProperty(rejected, 'raiOfficialFallback', { value: true });
                return rejected;
            } });
        for (let attempt = 0; ; attempt++) {
            try { await unavailable(fallbackUrl, { ...options(), body: JSON.stringify(completedBody) }); assert.fail('all original-model attempts must fail'); }
            catch (error) {
                assert.equal(error.code, 'gpt_primary_temporarily_unavailable');
                if (!canRetryStream(error, { attempt, cancelled: false, remainingMs })) break;
            }
        }
        assert.equal(primaryCalls, stop === 'budget' ? 1 : MAX_STREAM_RETRIES + 1, 'original-model recovery uses the existing request budget and retry limit');
    }
    for (const primaryStatus of [400, 401, 402, 403, 404]) {
        const terminal = createGptPrimaryFetch({ primaryUrl, primaryKey: 'fixture', fallbackUrl,
            fetchImpl: async () => new Response('PRIVATE_PRIMARY_BODY', { status: primaryStatus }),
            fallbackFetch: async () => {
                const rejected = new Response('PRIVATE_BILLING_BODY', { status: 402 });
                Object.defineProperty(rejected, 'raiOfficialFallback', { value: true });
                return rejected;
            } });
        const response = await terminal(fallbackUrl, options());
        assert.equal(response.status, 402);
        assert.equal(canRetryStream({ status: response.status }, { attempt: 0, cancelled: false, remainingMs: 5000 }), false);
        await response.body.cancel();
    }
    const directBilling = createGptPrimaryFetch({ primaryUrl, primaryKey: 'fixture', fallbackUrl,
        fetchImpl: async () => { throw new Error('must not call primary'); }, fallbackFetch: async () => new Response('', { status: 402 }) });
    assert.equal((await directBilling('https://other.test', options())).status, 402);
    const unmarkedBilling = createGptPrimaryFetch({ primaryUrl, primaryKey: 'fixture', fallbackUrl,
        fetchImpl: async () => new Response('', { status: 503 }), fallbackFetch: async () => new Response('', { status: 402 }) });
    assert.equal((await unmarkedBilling(fallbackUrl, options())).status, 402, 'a direct Fast 402 does not carry the official-fallback retry marker');
    const cancelController = new AbortController(), cancelReason = new Error('fixture cancellation during billing cleanup');
    let cancelledBilling = 0;
    const cancelledFallback = createGptPrimaryFetch({ primaryUrl, primaryKey: 'fixture', fallbackUrl,
        fetchImpl: async () => new Response('', { status: 503 }), fallbackFetch: async () => {
            const rejected = new Response(new ReadableStream({ async cancel() {
                cancelledBilling++; cancelController.abort(cancelReason); await delay(5);
            } }), { status: 402 });
            Object.defineProperty(rejected, 'raiOfficialFallback', { value: true });
            return rejected;
        } });
    await assert.rejects(cancelledFallback(fallbackUrl, options(true, cancelController.signal)), error => error === cancelReason);
    assert.equal(cancelledBilling, 1);
    console.log('gpt-provider-fallback PASS: M priority, effective deltas, on/off reasoning, cancellation and cleanup, bounded original-GPT recovery after official 402, terminal failures preserved, completed tools retained, raw timing and provenance');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
