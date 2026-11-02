'use strict';
// Isolated loopback integration: real auth, server route, stream completion and SQLite quota.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),http=require('node:http'),net=require('node:net');
const {spawn}=require('node:child_process'),bcrypt=require('bcrypt'),sqlite3=require('sqlite3');
const ROOT=path.resolve(__dirname,'..');
const randomSecret=()=>crypto.randomBytes(48).toString('base64url');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const openDatabase=filename=>new Promise((resolve,reject)=>{const db=new sqlite3.Database(filename,e=>e?reject(e):resolve(db));});
const dbRun=(db,sql,params=[])=>new Promise((resolve,reject)=>db.run(sql,params,function(e){e?reject(e):resolve(this);}));
const dbGet=(db,sql,params=[])=>new Promise((resolve,reject)=>db.get(sql,params,(e,row)=>e?reject(e):resolve(row)));
const closeDatabase=db=>new Promise(resolve=>db.close(resolve));
async function listen(server){await new Promise(r=>server.listen(0,'127.0.0.1',r));return 'http://127.0.0.1:'+server.address().port;}
async function reservePort(){const server=net.createServer();await listen(server);const port=server.address().port;await new Promise(r=>server.close(r));return port;}
async function loginSeededUser(databasePath, baseUrl) {
  const email = `skills-${crypto.randomBytes(5).toString('hex')}@local.test`;
  const password = randomSecret() + "Z9!";
  const db = await openDatabase(databasePath);
  try {
    await dbRun(
      db,
      `INSERT INTO users
       (email, password_hash, username, email_verified, email_verified_at, points, session_version, password_policy_version)
       VALUES (?, ?, 'Skill Runtime', 1, CURRENT_TIMESTAMP, 100000, 1, 1)`,
      [email, await bcrypt.hash(password, 6)]
    );
  } finally {
    await closeDatabase(db);
  }
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, fingerprint: 'skill-runtime-regression' })
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.ok(payload.token);
  return payload.token;
}


async function main(){
 if(process.platform==='win32'){console.log('chat-model-runtime: Linux permission-specific test (run in formal CI)');return;}
 const official=process.argv.includes('--official');const dsModel=official?'deepseek-flash':'deepseek-v4.1-flash';
 const adminPassword=randomSecret();
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'rai-model-runtime-')),databasePath=path.join(temp,'isolated.sqlite');let child,logs='',observations=[];
 let mode='answer',summaryCalls=0; const provider=http.createServer(async(req,res)=>{
  let raw='';for await(const part of req)raw+=part;let body;try{body=JSON.parse(raw);}catch(_){res.writeHead(400);res.end();return;}
  observations.push({url:req.url,host:req.headers.host,body});
  if(body.stream===false){summaryCalls++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:'Summary preserves facts and pending task.'},finish_reason:'stop'}]}));return;}
  if(mode==='failure'){res.writeHead(503);res.end('{}');return;}
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  if(mode==='remote'&&!body.messages.some(m=>m.role==='tool')){
   res.write('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'call_remote_test',type:'function',function:{name:'list_files',arguments:JSON.stringify({path:''})}}]},finish_reason:'tool_calls'}]})+'\n\n');
   res.write('data: '+JSON.stringify({choices:[],usage:{prompt_tokens:100,completion_tokens:4,prompt_cache_hit_tokens:80}})+'\n\n');res.end('data: [DONE]\n\n');return;
  }
  if(mode==='cancel'){res.write('data: '+JSON.stringify({choices:[{delta:{content:'partial'},finish_reason:null}]})+'\n\n');req.on('close',()=>res.end());return;}
  if(body.model==='gpt-6.1-sol')res.write('data: '+JSON.stringify({choices:[{delta:{reasoning_content:'Provider reasoning.'}}]})+'\n\n');
  res.write('data: '+JSON.stringify({choices:[{delta:{content:'Runtime answer complete.'},finish_reason:mode==='length'?'length':'stop'}]})+'\n\n');
  if(mode!=='remote')for(let i=0;i<2;i++)res.write('data: '+JSON.stringify({choices:[],usage:{prompt_tokens:1024,completion_tokens:8,total_tokens:1032,prompt_cache_hit_tokens:768}})+'\n\n');
  res.end('data: [DONE]\n\n');
 });
 const primaryProvider=http.createServer(provider.listeners('request')[0]),primaryBase=await listen(primaryProvider);
 const providerBase=await listen(provider),port=await reservePort(),baseUrl='http://127.0.0.1:'+port,key=path.join(temp,'key');fs.writeFileSync(key,randomSecret(),{mode:0o600});
 try{
  child=spawn(process.execPath,[path.join(ROOT,'server.js')],{cwd:ROOT,stdio:['ignore','pipe','pipe'],env:{...process.env,NODE_ENV:'test',NODE_OPTIONS:'',BIND_HOST:'127.0.0.1',HOST:'127.0.0.1',PORT:String(port),TRUST_PROXY:'false',JWT_SECRET:randomSecret(),ADMIN_JWT_SECRET:randomSecret(),ADMIN_USERNAME:'runtime-admin',ADMIN_PASSWORD_HASH:await bcrypt.hash(adminPassword,6),ADMIN_TOTP_REQUIRED:'false',ADMIN_TOTP_SECRET:'',RAI_TOTP_ENCRYPTION_KEY:randomSecret(),RAI_REFRESH_TOKEN_PEPPER:randomSecret(),RAI_DB_PATH:databasePath,RAI_RUNTIME_REPORT_PATH:path.join(temp,'report.md'),PUBLIC_BASE_URL:baseUrl,CORS_ORIGINS:baseUrl,RAI_DEFAULT_DOMAIN_NOTICE_ENABLED:'false',RAI_DOCUMENT_PARSER_ENABLED:'false',RAI_CHAT_QUOTA_PER_MINUTE:'100',RAI_CHAT_QUOTA_PER_5H:'1',RAI_CHAT_QUOTA_PER_WEEK:'1',ZTX6D_FORCE_DISABLED:'true',AGENT_HARD_DISABLE:'1',TAVILY_API_KEY:'',SILICONFLOW_API_KEY:'',GOOGLE_GEMINI_API_KEY:'',OPENROUTER_API_KEY:'',DEEPSEEK_API_KEY:randomSecret(),RAI_LUNA_GATEWAY_BASE_URL:primaryBase+'/v1',RAI_LUNA_GATEWAY_API_KEY_FILE:key,RAI_GPT_GATEWAY_BASE_URL:providerBase+'/v1',RAI_GPT_GATEWAY_API_KEY_FILE:key,RAI_GPT_PRIMARY_BASE_URL:primaryBase+'/v1',RAI_GPT_PRIMARY_API_KEY_FILE:key,RAI_DEEPSEEK_PROVIDER:official?'official':'relay',RAI_DEEPSEEK_FAST_BASE_URL:providerBase+'/v1',RAI_DEEPSEEK_FAST_API_KEY_FILE:key,RAI_TEST_DEEPSEEK_CHAT_COMPLETIONS_URL:providerBase+'/official/v1/chat/completions'}});
  child.stdout.on('data',x=>logs=(logs+x).slice(-100000));child.stderr.on('data',x=>logs=(logs+x).slice(-100000));
  for(let i=0;i<450;i++){if(child.exitCode!==null)throw Error('isolated server exit '+logs);try{if((await fetch(baseUrl+'/api/version')).ok)break;}catch(_){}await delay(100);if(i===449)throw Error('readiness timeout '+logs);}
  const token=await loginSeededUser(databasePath,baseUrl),headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
  const db=await openDatabase(databasePath);
  try{
   await dbRun(db,'UPDATE users SET points=0,purchased_points=0');
   async function chat(model,fields={}){const response=await fetch(baseUrl+'/api/chat/stream',{method:'POST',headers,body:JSON.stringify({model,messages:[{role:'user',content:'Say hello.'}],internetMode:false,memoryMode:'off',thinkingMode:true,reasoningProfile:'medium',...fields})});const raw=await response.text();return{status:response.status,raw,events:raw.split(/\r?\n/).filter(x=>x.startsWith('data: ')&&!x.includes('[DONE]')).map(x=>JSON.parse(x.slice(6)))};}
   const availability=await(await fetch(baseUrl+'/api/model-availability')).json();assert.deepEqual(availability.models.map(x=>x.id),['deepseek-v4.1-flash','gpt-6.1-sol','gpt-6-luna','gpt-6-astra']);assert.deepEqual(availability.models.find(x=>x.id==='gpt-6-luna').limits,{free:100,pro:200,max:500});assert.equal(availability.contextWindow,272000);
   async function gptTurnCount(){return await dbGet(db,"SELECT name FROM sqlite_master WHERE type='table' AND name='chat_model_turns'")?(await dbGet(db,"SELECT count(*) AS n FROM chat_model_turns")).n:0;}
   const gptTurnsBefore=await gptTurnCount();
   for(const fields of [{thinkingMode:false,reasoningProfile:'max'},{thinkingMode:false,reasoningProfile:undefined}]){
    const start=observations.length,result=await chat('auto',fields);
    assert.ok(result.events.some(x=>x.type==='done'&&x.actualModel===dsModel),result.raw.slice(-3000));
    const request=observations.slice(start).find(x=>x.body.stream);
    assert.equal(request.body.model,dsModel);assert.equal(request.body.thinking.type,'disabled');
    assert.equal(request.body.stream_options.include_usage,true);
    if(official)assert.equal(request.url,'/official/v1/chat/completions','default smart must directly reach the official endpoint');
    const metered=result.events.filter(x=>x.type==='usage');assert.equal(metered.at(-1).usage.prompt_cache_hit_tokens,768);assert.equal(metered.at(-1).usage.prompt_tokens,1024,'duplicate provider snapshots must not double usage');
   }
   assert.equal(await gptTurnCount(),gptTurnsBefore,'default smart cannot reserve or spend GPT allowance');
   for(let i=0;i<3;i++){const response=await chat('gpt-6-astra');assert.equal(response.status,200);assert.ok(response.events.some(x=>x.type==='done'&&!x.degraded),response.raw.slice(-3000));}
   assert.equal((await dbGet(db,"SELECT count(*) AS n FROM chat_model_turns WHERE model_id='gpt-6-astra' AND status='completed'")).n,3);
   const before=observations.length,blocked=await chat('gpt-6-astra');assert.equal(blocked.status,429);assert.equal(JSON.parse(blocked.raw).code,'model_chat_quota_exceeded');assert.equal(observations.length,before,'quota cannot issue provider request');
   const minimumEffort=await chat('gpt-6.1-sol',{thinkingMode:false});assert.ok(minimumEffort.events.some(x=>x.type==='done'&&!x.degraded),minimumEffort.raw.slice(-2000));assert.equal(observations.filter(x=>x.body.model==='gpt-6.1-sol').at(-1).body.reasoning_effort,'low');
   assert.ok(minimumEffort.events.some(x=>x.type==='reasoning'&&x.content==='Provider reasoning.'),'legacy GPT off must reveal actual low reasoning');
   assert.equal(observations.filter(x=>x.body.model==='gpt-6.1-sol').at(-1).host,new URL(primaryBase).host,'GPT uses M primary before Fast');
   await delay(20);
   const timeline=logs.split(/\r?\n/).flatMap(line=>{try{return [JSON.parse(line)];}catch(_){return [];}}).filter(x=>x.event==='chat_latency'&&x.model==='gpt-6.1-sol').at(-1);
   assert.ok(timeline,'completed request emits one latency summary');
   assert.equal(timeline.attempts[0].provider,'gpt_mirrorium');
   assert.ok(timeline.stages.first_reasoning_write>=timeline.attempts[0].first_reasoning);
   assert.ok(timeline.stages.first_content_write>=timeline.attempts[0].first_content);
   assert.equal(timeline.attempts[0].fallback,false);
   const beforeLuna=observations.length;const lunaCompat=await chat('gpt-6-luna',{thinkingMode:false});assert.ok(lunaCompat.events.some(x=>x.type==='done'&&!x.degraded),lunaCompat.raw.slice(-1000));const lunaCompatRequest=observations.slice(beforeLuna).find(x=>x.body.stream);assert.equal(lunaCompatRequest.body.model,'gpt-6-luna');assert.equal(lunaCompatRequest.body.reasoning_effort,'none');assert.equal(lunaCompatRequest.host,new URL(primaryBase).host,'Luna uses dedicated gateway, never M/Fast');
   // Vision stays on the explicitly selected DeepSeek model.
   const vision=await chat('deepseek-v4.1-flash',{messages:[{role:'user',content:'Read this image.',attachments:[{type:'image',data:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/yUAAAAASUVORK5CYII=',mimeType:'image/png',fileName:'pixel.png'}]}]});assert.ok(vision.events.some(x=>x.type==='model_info'&&x.model==='deepseek-v4.1-flash'),vision.raw.slice(-2000));assert.ok(observations.at(-1).body.messages.some(m=>Array.isArray(m.content)&&m.content.some(x=>x.type==='image_url')),'vision preserved');
   if(official){const request=observations.at(-1);assert.equal(request.url,'/official/v1/chat/completions','official selection must bypass the configured relay entirely');assert.equal(request.body.thinking.type,'enabled');}
   // Authenticated uploads: two owned images + a text file reach one native vision request.
   const pixel=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/yUAAAAASUVORK5CYII=','base64');
   const mixed=[];
   for(const [name,mime,content,type] of [['one.png','image/png',pixel,'image'],['two.png','image/png',pixel,'image'],['notes.txt','text/plain',Buffer.from('MULTI_FILE_FIXTURE_NOTE'),'text']]){
    const session=await fetch(baseUrl+'/api/uploads/sessions',{method:'POST',headers,body:JSON.stringify({fileName:name,size:content.length,mimeType:mime})});
    assert.equal(session.status,201);const upload=await session.json();
    const form=new FormData();form.append('file',new Blob([content],{type:mime}),name);
    const transfer=await fetch(baseUrl+'/api/upload',{method:'POST',headers:{Authorization:'Bearer '+token,'X-RAI-Upload-ID':upload.uploadId},body:form});
    const result=await transfer.json();assert.equal(transfer.status,200,JSON.stringify(result));
    mixed.push({type,fileName:name,mimeType:mime,size:content.length,fileId:result.file.filename,filePath:result.file.filePath});
   }
   const combined=await chat('deepseek-v4.1-flash',{messages:[{role:'user',content:'Compare both images using the attached note.',attachments:mixed}],reasoningProfile:'auto'});
   assert.ok(combined.events.some(x=>x.type==='done'&&!x.degraded),combined.raw.slice(-2000));
   const mixedBody=observations.filter(x=>x.body.model===dsModel&&x.body.stream).at(-1).body;
   assert.equal(mixedBody.messages.flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(c=>c.type==='image_url').length,2,'both uploaded images reach provider');
   assert.ok(JSON.stringify(mixedBody.messages).includes('MULTI_FILE_FIXTURE_NOTE'),'uploaded text context reaches the same request');
   const history=Array.from({length:18},(_,i)=>({role:i%2?'assistant':'user',content:'Old fact '+i+' '+ '中'.repeat(9000)}));history.push({role:'user',content:'LATEST_USER_QUESTION'});
   const compressed=await chat('gpt-6.1-sol',{messages:history,reasoningProfile:'auto'});assert.ok(compressed.events.some(x=>x.type==='context_compressed'),compressed.raw.slice(-4000)+'\n'+logs.slice(-18000));assert.ok(compressed.events.some(x=>x.type==='done'&&!x.degraded),compressed.raw.slice(-3000));assert.ok(summaryCalls>0);const last=observations.filter(x=>x.body.model==='gpt-6.1-sol').at(-1).body;assert.ok(last.messages.some(x=>x.content==='LATEST_USER_QUESTION'));assert.equal(Object.hasOwn(last,'reasoning_effort'),false,'Adaptive survives compression and provider wrapper');assert.equal((await dbGet(db,"SELECT count(*) AS n FROM chat_model_turns WHERE model_id='gpt-6.1-sol' AND status='completed'")).n,2);
   // Actual provider ID is terminal metadata and SQLite history, not the selection alias.
   const user=await dbGet(db,'SELECT id FROM users LIMIT 1'),provenanceChat='provenance-'+crypto.randomBytes(12).toString('hex');
   await dbRun(db,'INSERT INTO sessions (id,user_id,title,model) VALUES (?,?,?,?)',[provenanceChat,user.id,'Provenance fixture','auto']);
   const smart=await chat('auto',{sessionId:provenanceChat,thinkingMode:true,reasoningProfile:undefined});
   assert.ok(smart.events.some(x=>x.type==='model_info'&&x.actualModel==='gpt-6.1-sol'),smart.raw.slice(-2000));
   assert.equal(smart.events.find(x=>x.type==='done').actualModel,'gpt-6.1-sol');
   assert.equal(observations.filter(x=>x.body.model==='gpt-6.1-sol'&&x.body.stream).at(-1).body.reasoning_effort,'low','Smart thinking without explicit effort uses administrator low default');
   assert.equal((await dbGet(db,"SELECT model FROM messages WHERE session_id=? AND role='assistant' ORDER BY id DESC LIMIT 1",[provenanceChat])).model,'gpt-6.1-sol');
   mode='failure';const failed=await chat('gpt-6.1-sol');assert.ok(failed.events.some(x=>x.type==='error'),failed.raw.slice(-3000));assert.equal((await dbGet(db,"SELECT count(*) AS n FROM chat_model_turns WHERE model_id='gpt-6.1-sol' AND status='completed'")).n,3);mode='answer';
   // The failed upstream trips its circuit: user still selects Sol, actual answer uses DeepSeek.
   const rerouted=await chat('gpt-6.1-sol',{sessionId:provenanceChat,thinkingMode:false});
   const terminalModel=rerouted.events.find(x=>x.type==='done')?.actualModel;
   assert.equal(terminalModel,dsModel,rerouted.raw.slice(-2000));
   assert.equal((await dbGet(db,"SELECT model FROM messages WHERE session_id=? AND role='assistant' ORDER BY id DESC LIMIT 1",[provenanceChat])).model,terminalModel,'history must preserve rerouted upstream ID, not selected Sol');
   assert.equal((await dbGet(db,'SELECT points FROM users')).points,0,'chat must not debit points');
   // Real login + software identity + chat -> approved PC -> one-shot tool -> continuation.
   const {createSoftwareClientAuth}=require('../lib/software-client-auth');
   const identity=await createSoftwareClientAuth({db}).create({name:'Isolated CX remote test',platform:'windows'});
   const nativeHeaders={...headers,'X-RAI-Client-Key':identity.rawKey};
   const actor=await dbGet(db,'SELECT id FROM users LIMIT 1'),remoteChat='remote-'+crypto.randomBytes(12).toString('hex');
   await dbRun(db,'INSERT INTO sessions (id,user_id,title,model) VALUES (?,?,?,?)',[remoteChat,actor.id,'Remote fixture','gpt-6.1-sol']);
   async function remote(path,method='GET',body,auth=headers){const r=await fetch(baseUrl+'/api/cx-remote'+path,{method,headers:auth,body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json();assert.equal(r.status,200,JSON.stringify(data));return data;}
   const computer=(await remote('/devices','POST',{platform:'windows',name:'Isolated PC',version:'1.8.7'},nativeHeaders)).device;
   const deviceHeaders={...nativeHeaders,'X-CX-Device-Key':computer.deviceKey},devicePath='/devices/'+computer.id;
   const link=(await remote('/sessions','POST',{deviceId:computer.id,conversationId:remoteChat})).session;
   await remote(devicePath+'/approve','POST',{sessionId:link.id,approved:true},deviceHeaders);
   mode='remote';const stream=chat('auto',{sessionId:remoteChat,reasoningProfile:'low',messages:[{role:'user',content:'List the files on my connected computer.'}],local_agent:{protocolVersion:'cx-online-v1',sessionId:link.id}});
   let remoteTask;
   for(let i=0;i<250&&!remoteTask;i++){remoteTask=(await remote(devicePath+'/poll','GET',undefined,deviceHeaders)).tasks[0];if(!remoteTask)await delay(100);}
   assert.ok(remoteTask,'chat must dispatch the remote tool');assert.equal(remoteTask.tool,'list_files');
   await remote(devicePath+'/tasks/'+remoteTask.id+'/start','POST',{},deviceHeaders);
   await remote(devicePath+'/tasks/'+remoteTask.id+'/result','POST',{result:{success:true,path:'fixture',entries:[{name:'remote-note.txt',type:'file'}],output:'目录: fixture (1 项)\n  [文件] remote-note.txt'}},deviceHeaders);
   const completed=await stream;const remoteContinuation=observations.filter(x=>x.body.stream===true&&x.body.messages.some(m=>m.role==='tool'&&String(m.content).includes('remote-note.txt'))).at(-1);assert.ok(remoteContinuation,'remote continuation is observed');assert.equal(remoteContinuation.body.reasoning_effort,remoteContinuation.body.model==='deepseek-flash'?'high':'low','Continuation preserves selected effort or official DeepSeek minimum');assert.ok(completed.events.some(x=>x.type==='done'&&!x.degraded),completed.raw.slice(-4000));
   const remoteUsage=completed.events.filter(x=>x.type==='usage');
   assert.ok(remoteUsage.some(x=>x.usage.prompt_cache_hit_tokens===80),'initial tool call reports genuine known cache');
   assert.equal(remoteUsage.at(-1).usage_scope,'request');
   assert.deepEqual(remoteUsage.at(-1).usage,{},'a successful continuation that omits usage clears prior counters instead of presenting a partial total');
   assert.ok(observations.some(x=>x.body.stream===true&&x.body.messages.some(m=>m.role==='tool'&&String(m.content).includes('remote-note.txt'))),'PC result must reach streaming provider continuation (exclude later title generation)');
   assert.ok(!completed.events.some(x=>x.type==='local_agent_tool_call'||x.type==='client_tool_call'),'Web must not execute desktop tool payload');
   await remote(devicePath,'DELETE',undefined,deviceHeaders);mode='answer';

   const lunaBefore=observations.length,lunaOff=await chat('gpt-6-luna',{thinkingMode:false,reasoningProfile:'high'});assert.ok(lunaOff.events.some(x=>x.type==='done'&&!x.degraded),lunaOff.raw.slice(-2000));const lunaRequest=observations.slice(lunaBefore).find(x=>x.body.stream);assert.equal(lunaRequest.host,new URL(primaryBase).host);assert.equal(lunaRequest.body.reasoning_effort,'none');assert.equal(Object.hasOwn(lunaRequest.body,'thinking'),false);assert.equal(Object.hasOwn(lunaRequest.body,'temperature'),false);assert.equal((await dbGet(db,"SELECT count(*) AS n FROM chat_model_turns WHERE model_id='gpt-6-luna' AND status='completed'")).n,1);
      // Administrator uses its independent bearer session. Custom IDs intentionally lack a GPT prefix.
   const login=await fetch(baseUrl+'/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'runtime-admin',password:adminPassword})});
   const adminLogin=await login.json();assert.equal(login.status,200,JSON.stringify(adminLogin));
   async function admin(route,method='GET',body,status=200){const response=await fetch(baseUrl+'/api/admin/'+route,{method,headers:{'Content-Type':'application/json',Authorization:'Bearer '+adminLogin.token},body:body===undefined?undefined:JSON.stringify(body)});const result=await response.json();assert.equal(response.status,status,JSON.stringify(result));return result;}
   assert.equal((await admin('verify')).success,true);
   const defaults=(await admin('runtime-settings')).settings;
   assert.equal(defaults.smart_default_model,'gpt-6.1-sol');assert.equal(defaults.smart_reasoning_profile,'low');
   const custom={id:'custom-runtime-test',name:'Custom runtime',provider:'rai_gpt_gateway',vision:true,supportsThinking:true,canDisableThinking:false,thinkingProfiles:['auto','low','high','xhigh'],contextWindow:272000,compressionThreshold:258000,limits:{free:2,pro:5,max:10},pointCost:0};
   const created=await admin('models','POST',custom,201);assert.ok(created.models.some(m=>m.id===custom.id&&m.builtin===false));
   await admin('runtime-settings','PUT',{settings:{smart_default_model:custom.id,smart_reasoning_profile:'xhigh'}});
   const customBefore=observations.length,customAnswer=await chat('auto',{reasoningProfile:undefined});assert.ok(customAnswer.events.some(x=>x.type==='done'&&x.actualModel===custom.id),customAnswer.raw.slice(-3000));
   const customBody=observations.slice(customBefore).find(x=>x.body.stream).body;assert.equal(customBody.model,custom.id);assert.equal(customBody.reasoning_effort,'xhigh');assert.equal(Object.hasOwn(customBody,'temperature'),false);
   assert.equal((await dbGet(db,"SELECT count(*) AS n FROM chat_model_turns WHERE model_id=? AND status='completed'",[custom.id])).n,1);
   await chat(custom.id,{reasoningProfile:'auto'});assert.equal(Object.hasOwn(observations.filter(x=>x.body.model===custom.id&&x.body.stream).at(-1).body,'reasoning_effort'),false);
   const exhausted=await chat(custom.id);assert.equal(exhausted.status,429);
   await admin('runtime-settings','PUT',{chat_per_minute:88,smart_reasoning_profile:'none'},400);assert.equal((await admin('runtime-settings')).settings.chat_per_minute,defaults.chat_per_minute,'invalid profile cannot partially write numeric settings');
   await dbRun(db,"CREATE TRIGGER fail_runtime_patch BEFORE INSERT ON admin_runtime_settings WHEN NEW.setting_key='chat_per_week' BEGIN SELECT RAISE(ABORT,'test rollback'); END");
   await admin('runtime-settings','PUT',{chat_per_minute:87,chat_per_week:100},500);await dbRun(db,'DROP TRIGGER fail_runtime_patch');assert.equal((await admin('runtime-settings')).settings.chat_per_minute,defaults.chat_per_minute,'DB failure must rollback whole settings patch');
   const available=await(await fetch(baseUrl+'/api/models/availability')).json();assert.equal(available.smartDefaults.model,custom.id);assert.equal(available.smartDefaults.reasoningProfile,'xhigh');assert.equal(available.contextPolicies[custom.id].compressionThreshold,258000);assert.equal(available.contextTokensEstimated,true);assert.equal(available.uploadFileNameMaxCharacters,255);assert.equal(available.conversationQuota.limits.free[custom.id],2);
   assert.ok(!JSON.stringify(available).includes('apiKey'));assert.deepEqual(available.models.find(x=>x.id==='deepseek-v4.1-flash').thinkingProfiles,['auto','high','max']);
   await admin('models','POST',{...custom,thinkingProfiles:['none']},400);
   await admin('models','POST',{...custom,id:'gpt-6.1-sol'},400);
   await admin('models/'+custom.id,'PUT',{enabled:false});const fallback=await(await fetch(baseUrl+'/api/models/availability')).json();assert.notEqual(fallback.smartDefaults.model,custom.id);
   await admin('models/'+custom.id,'PUT',{enabled:true});
   await admin('models','POST',{...custom,vision:false,limits:{free:4,pro:6,max:12},pointCost:2},201);
   assert.equal((await admin('models')).models.find(x=>x.id===custom.id).pointCost,2);
   await dbRun(db,'UPDATE users SET points=100');
   const noVision=await chat(custom.id,{messages:[{role:'user',content:'Look.',attachments:[{type:'image',data:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/yUAAAAASUVORK5CYII=',mimeType:'image/png',fileName:'pixel.png'}]}]});assert.ok(noVision.raw.includes('不支持图片'),noVision.raw.slice(-2000));
   // Simulated delete failure keeps both persisted catalog and runtime routing intact.
   await dbRun(db,"CREATE TRIGGER fail_catalog_delete BEFORE DELETE ON model_visibility WHEN OLD.model_id='custom-runtime-test' BEGIN SELECT RAISE(ABORT,'test rollback'); END");
   await admin('models/'+custom.id,'DELETE',undefined,500);await dbRun(db,'DROP TRIGGER fail_catalog_delete');assert.ok((await admin('models')).models.some(m=>m.id===custom.id));assert.ok(await dbGet(db,'SELECT model_id FROM admin_model_catalog WHERE model_id=?',[custom.id]));
   await admin('models/'+custom.id,'DELETE');assert.ok(!(await admin('models')).models.some(m=>m.id===custom.id));assert.equal((await admin('runtime-settings')).settings.smart_default_model,'gpt-6.1-sol');
   await admin('models/gpt-6.1-sol','DELETE',undefined,400);
   const longName='中'.repeat(252)+'.txt';assert.equal([...longName].length,256);
   const preflight=await fetch(baseUrl+'/api/uploads/sessions',{method:'POST',headers,body:JSON.stringify({fileName:longName,mimeType:'text/plain',size:2})});assert.equal(preflight.status,400);assert.equal((await preflight.json()).code,'FILE_NAME_TOO_LONG');
   const validName='中文'.repeat(100)+'.txt';
   const good=await fetch(baseUrl+'/api/uploads/sessions',{method:'POST',headers,body:JSON.stringify({fileName:validName,mimeType:'text/plain',size:2})});assert.equal(good.status,201);
   const session=await good.json(),form=new FormData();form.append('file',new Blob(['ok'],{type:'text/plain'}),longName);
   const rejected=await fetch(baseUrl+'/api/upload',{method:'POST',headers:{Authorization:'Bearer '+token,'X-RAI-Upload-ID':session.uploadId},body:form});assert.equal(rejected.status,400);assert.equal((await rejected.json()).code,'FILE_NAME_TOO_LONG');
   const progress=await(await fetch(baseUrl+'/api/uploads/'+session.uploadId+'/status',{headers})).json();assert.equal(progress.errorCode,'FILE_NAME_TOO_LONG');assert.equal(progress.status,'failed');
   const chinese=new FormData();chinese.append('file',new Blob(['ok'],{type:'text/plain'}),validName);const uploaded=await fetch(baseUrl+'/api/upload',{method:'POST',headers:{Authorization:'Bearer '+token},body:chinese});assert.equal(uploaded.status,200);assert.equal((await uploaded.json()).file.originalName,validName);
   await fetch(baseUrl+'/api/user/config',{method:'PUT',headers,body:JSON.stringify({default_model:'gpt-6-astra',reasoning_profile:'xhigh'})});
   await fetch(baseUrl+'/api/user/config',{method:'PUT',headers,body:JSON.stringify({theme:'light'})});const profile=await(await fetch(baseUrl+'/api/user/profile',{headers})).json();assert.equal(profile.default_model,'gpt-6-astra');assert.equal(profile.reasoning_profile,'xhigh');
   await admin('logout','POST');await admin('verify','GET',undefined,403);
   console.log('chat-model-runtime PASS: authenticated free account, 3 completed Astra turns then 429, zero points, Sol minimum effort and retired Luna migration, native DeepSeek vision, failure release, real long-context summarization, independent model allowances');
  }finally{await closeDatabase(db);}
 }catch(error){error.message+='\nIsolated server tail:\n'+logs.slice(-9000);throw error;}finally{if(child&&child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),delay(8000)]);if(child.exitCode===null)child.kill('SIGKILL');}provider.closeAllConnections?.();await new Promise(r=>provider.close(r));primaryProvider.closeAllConnections?.();await new Promise(r=>primaryProvider.close(r));const safe=fs.realpathSync(temp),base=fs.realpathSync(os.tmpdir());assert.ok(safe.startsWith(base+path.sep)&&path.basename(safe).startsWith('rai-model-runtime-'));fs.rmSync(safe,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
