'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const arg=name=>{const i=process.argv.indexOf(name);return i<0?'':process.argv[i+1];};
const root=path.resolve(arg('--root')||path.join(__dirname,'..'));
const overlay=arg('--overlay');
const server=fs.readFileSync(path.join(overlay||root,'server.js'),'utf8').replace(/\r\n/g,'\n');
function between(text,start,end){const a=text.indexOf(start),b=text.indexOf(end,a+start.length);assert.ok(a>=0&&b>a,'Production anchor moved: '+start);return text.slice(a,b);}
const managed=between(server,'async function callK2p5Stream(','\nfunction researchModelLabel(');
const parallel=between(server,'async function runTrueParallelAgentMode(','\n// ==================== 多模态');
const routeCall=between(server,'                    const agentResult = await runTrueParallelAgentMode({','                    let contentToSave =');
const innerCatch=between(server,'                } catch (agentPipelineError) {','\n            }\n        }\n\n        try {\n            agentRuntime = runAgentOrchestrator(').replace(/^\s*} catch \(agentPipelineError\) \{/,'').replace(/\n\s*}\s*$/,'');
const outerSection=between(server,"        console.log('\\n 聊天处理完成\\n');",'    } finally {\n        clearInterval(quotaLeaseTimer);');
const outerCatch=outerSection.slice(outerSection.indexOf('    } catch (error) {')+'    } catch (error) {'.length);
if(!process.argv.includes('--baseline')){
  assert.ok(/let parallelAgentCommitted = false;\s+const agentRequestController = createChatAbortController\(\);\s+try \{/.test(server),'Missing route commitment state');
  assert.ok(/onProgressCommitted: \(\) => \{ parallelAgentCommitted = true; \}/.test(routeCall),'Missing route progress callback');
}

async function exercise(scenario){
  const events=[],stats={tools:0,requests:0,fallbacks:0,releases:0,aborts:0};
  const failure=new Error('fixture-'+scenario);
  const controller=new AbortController();
  controller.signal.addEventListener('abort',()=>{stats.aborts++;});
  const res={headersSent:true,writableEnded:false,write(wire){events.push(JSON.parse(wire.slice(6)));},end(){this.writableEnded=true;}};
  const context=vm.createContext({
    console:{log(){},warn(){},error(){}},AbortController,TextDecoder,DOMException,setTimeout,clearTimeout,
    res,stats,failure,scenario,agentRequestController:controller,agentUserMessage:'fixture',
    MODEL_ROUTING:{'deepseek-v4.1-flash':{provider:'fixture',model:'fixture-model'}},
    API_PROVIDERS:{fixture:{baseURL:'http://provider.test',apiKey:'fixture'}},AGENT_MAX_RETRIES:1,
    createSearchBudget:()=>({}),buildHistoryContext:()=>'',emitAgentEvent:(_res,payload)=>res.write('data: '+JSON.stringify(payload)+'\n\n'),
    normalizeUsage:x=>x||{},isKimiK25ActualModel:()=>false,resolveThinkingBudgetForModel:()=>null,
    throwIfExternalRequestAborted:signal=>{if(signal?.aborted)throw failure;},linkImageProviderAbort:()=>()=>{},
    TOOL_DEFINITIONS:[{type:'function',function:{name:'save_memory'}}],
    extractReasoningTextFromPayload:()=>'',normalizeToolCalls:calls=>calls.map(x=>({...x,_args:{}})),
    assignStableSourceMarkers:x=>x,dedupeSources:x=>x,
    appendAnnotatedSources:(current,sources)=>({merged:current.concat(sources),newlyAdded:sources}),
    emitSourcesEvent:()=>{},buildToolResultForLLM:({result})=>result,buildToolRoundInstruction:()=>'',
    executeNormalizedToolCall:async()=>{stats.tools++;if(scenario==='tool-throws')throw failure;return{result:{success:true},sources:[],searchCountInc:0};},
    fetchModelProvider:async()=>{
      const i=stats.requests++;
      const tools=i===0?[{index:0,id:'one',type:'function',function:{name:'save_memory',arguments:'{}'}}]:[];
      return new Response('data: '+JSON.stringify({choices:[{delta:tools.length?{tool_calls:tools}:{},finish_reason:tools.length?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');
    },
    applyQualityGate:()=>({pass:true}),buildConservativeFallbackNote:()=>'',sanitizeReportContext:x=>x.message,
    releaseActiveRequest:async()=>{stats.releases++;},rejectClientToolPending:()=>{},
    persistSessionStreamDraft:async()=>{},broadcastSessionStreamState:()=>{},cleanupSessionStreamState:()=>{},
    runAgentPipeline:async options=>{
      if(scenario==='body'||scenario==='write-throws')options.onContent('BODY_ONCE');
      else if(scenario==='reasoning')options.onReasoning('Reasoning shown');
      else if(scenario==='draft')options.emitEvent({type:'agent_draft_delta',delta:'Visible draft'});
      else if(scenario==='draft-summary')options.emitEvent({type:'agent_draft',summary:'Visible summary'});
      else if(scenario==='planner')await options.callPlanner({plannerPrompt:'fixture',userMessage:'fixture'});
      else if(scenario.startsWith('tool-'))await options.callSubAgent({task:{agent_id:1},subPrompt:'fixture'});
      else if(scenario==='empty-draft')options.emitEvent({type:'agent_draft_delta',reset:true,delta:''});
      else if(scenario==='status-only')options.emitEvent({type:'agent_status',status:'running'});
      if(scenario==='post-success')return{content:'',sources:[]};
      throw failure;
    }
  });
  if(scenario==='planner')context.fetchModelProvider=async()=>new Response('data: '+JSON.stringify({choices:[{delta:{content:'Visible planner JSON'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
  if(scenario==='post-success')context.runAgentPipeline=async options=>{options.onContent('BODY_ONCE');return{content:'BODY_ONCE'};};
  if(scenario==='write-throws'){
    const write=res.write;
    res.write=wire=>{write.call(res,wire);if(wire.includes('BODY_ONCE'))throw failure;};
  }
  vm.runInContext(managed+'\n'+parallel,context);
  vm.runInContext(`globalThis.run=async()=>{
    let parallelAgentCommitted=false,effectiveAgentMode='on';
    const messages=[],userContent='fixture',systemPrompt='',userIdentityInstruction='',activeDomainInstruction='',activeRuleInstruction='';
    const resolvedPromptRule=null,thinkingMode=false,thinkingBudget=1024,internetMode=true,qualityProfile='high',max_tokens=1000,agentTraceLevel='full';
    const req={user:{userId:1}},sessionId='session',requestId='request',onAgentEvent=()=>{},liveStreamState=null;
    let clientAborted=false,chatRequestCancelled=false;
    try {
      try {
        ${routeCall}
        // A downstream persistence/quota/release failure after successful synthesis.
        throw failure;
      } catch(agentPipelineError) {
        ${innerCatch}
      }
      stats.fallbacks++;
      res.write('data: '+JSON.stringify({type:'content',content:'FALLBACK_BODY'})+'\\n\\n');
    } catch(error) {
      stats.outerError=error===failure;
      ${outerCatch}
    }
    return {committed:parallelAgentCommitted,effectiveAgentMode};
  };`,context);
  const result=await context.run();
  const allowed=['preflight','status-only','empty-draft'].includes(scenario);
  assert.equal(stats.fallbacks,allowed?1:0,scenario+': single-model restart boundary');
  assert.equal(events.filter(x=>x.content==='FALLBACK_BODY').length,allowed?1:0);
  assert.equal(stats.outerError===true,!allowed,scenario+': original error must reach existing outer finalizer');
  assert.equal(result.committed,!allowed);
  assert.equal(stats.aborts,1,scenario+': retire parallel controller on failure');
  if(!allowed){
    assert.equal(res.writableEnded,true);
    assert.equal(events.filter(x=>x.type==='error'&&x.code==='chat_request_failed').length,1);
    assert.equal(result.effectiveAgentMode,'on','Unsafe failure cannot switch to single-model mode');
  }
  assert.equal(stats.tools,scenario.startsWith('tool-')?1:0,'No tool replay');
  if(scenario==='tool-throws')assert.equal(stats.requests,1,'No continuation or restart after tool side effect throws');
  if(scenario==='tool-success')assert.equal(stats.requests,2,'Only original tool continuation, no restarted provider');
  assert.ok(events.filter(x=>x.content==='BODY_ONCE').length<=1);
  console.log('PASS '+scenario+': fallback='+stats.fallbacks+', executed tools='+stats.tools+', outer error='+!!stats.outerError);
}
(async()=>{for(const scenario of process.argv.includes('--baseline')?['body']:['preflight','status-only','empty-draft','body','reasoning','draft','draft-summary','planner','tool-success','tool-throws','post-success','write-throws'])await exercise(scenario);})().catch(error=>{console.error(error);process.exitCode=1;});
