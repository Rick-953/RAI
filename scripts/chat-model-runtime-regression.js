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
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'rai-model-runtime-')),databasePath=path.join(temp,'isolated.sqlite');let child,logs='',observations=[];
 let mode='answer',summaryCalls=0; const provider=http.createServer(async(req,res)=>{
  let raw='';for await(const part of req)raw+=part;let body;try{body=JSON.parse(raw);}catch(_){res.writeHead(400);res.end();return;}
  observations.push({url:req.url,body});
  if(body.stream===false){summaryCalls++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:'Summary preserves facts and pending task.'},finish_reason:'stop'}]}));return;}
  if(mode==='failure'){res.writeHead(503);res.end('{}');return;}
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  if(mode==='remote'&&!body.messages.some(m=>m.role==='tool')){
   res.write('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'call_remote_test',type:'function',function:{name:'list_files',arguments:JSON.stringify({path:''})}}]},finish_reason:'tool_calls'}]})+'\n\n');res.end('data: [DONE]\n\n');return;
  }
  if(mode==='cancel'){res.write('data: '+JSON.stringify({choices:[{delta:{content:'partial'},finish_reason:null}]})+'\n\n');req.on('close',()=>res.end());return;}
  res.write('data: '+JSON.stringify({choices:[{delta:{content:'Runtime answer complete.'},finish_reason:mode==='length'?'length':'stop'}]})+'\n\n');res.end('data: [DONE]\n\n');
 });
 const providerBase=await listen(provider),port=await reservePort(),baseUrl='http://127.0.0.1:'+port,key=path.join(temp,'key');fs.writeFileSync(key,randomSecret(),{mode:0o600});
 try{
  child=spawn(process.execPath,[path.join(ROOT,'server.js')],{cwd:ROOT,stdio:['ignore','pipe','pipe'],env:{...process.env,NODE_ENV:'test',NODE_OPTIONS:'',BIND_HOST:'127.0.0.1',HOST:'127.0.0.1',PORT:String(port),TRUST_PROXY:'false',JWT_SECRET:randomSecret(),ADMIN_JWT_SECRET:randomSecret(),ADMIN_PASSWORD_HASH:await bcrypt.hash(randomSecret(),6),RAI_TOTP_ENCRYPTION_KEY:randomSecret(),RAI_REFRESH_TOKEN_PEPPER:randomSecret(),RAI_DB_PATH:databasePath,RAI_RUNTIME_REPORT_PATH:path.join(temp,'report.md'),PUBLIC_BASE_URL:baseUrl,CORS_ORIGINS:baseUrl,RAI_DEFAULT_DOMAIN_NOTICE_ENABLED:'false',RAI_DOCUMENT_PARSER_ENABLED:'false',RAI_CHAT_QUOTA_PER_MINUTE:'100',RAI_CHAT_QUOTA_PER_5H:'1',RAI_CHAT_QUOTA_PER_WEEK:'1',ZTX6D_FORCE_DISABLED:'true',AGENT_HARD_DISABLE:'1',TAVILY_API_KEY:'',SILICONFLOW_API_KEY:'',GOOGLE_GEMINI_API_KEY:'',OPENROUTER_API_KEY:'',DEEPSEEK_API_KEY:randomSecret(),RAI_GPT_GATEWAY_BASE_URL:providerBase+'/v1',RAI_GPT_GATEWAY_API_KEY_FILE:key,RAI_DEEPSEEK_FAST_BASE_URL:providerBase+'/v1',RAI_DEEPSEEK_FAST_API_KEY_FILE:key,RAI_TEST_DEEPSEEK_CHAT_COMPLETIONS_URL:providerBase+'/official/v1/chat/completions'}});
  child.stdout.on('data',x=>logs=(logs+x).slice(-100000));child.stderr.on('data',x=>logs=(logs+x).slice(-100000));
  for(let i=0;i<450;i++){if(child.exitCode!==null)throw Error('isolated server exit '+logs);try{if((await fetch(baseUrl+'/api/version')).ok)break;}catch(_){}await delay(100);if(i===449)throw Error('readiness timeout '+logs);}
  const token=await loginSeededUser(databasePath,baseUrl),headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
  const db=await openDatabase(databasePath);
  try{
   await dbRun(db,'UPDATE users SET points=0,purchased_points=0');
   async function chat(model,fields={}){const response=await fetch(baseUrl+'/api/chat/stream',{method:'POST',headers,body:JSON.stringify({model,messages:[{role:'user',content:'Say hello.'}],internetMode:false,memoryMode:'off',thinkingMode:true,reasoningProfile:'medium',...fields})});const raw=await response.text();return{status:response.status,raw,events:raw.split(/\r?\n/).filter(x=>x.startsWith('data: ')&&!x.includes('[DONE]')).map(x=>JSON.parse(x.slice(6)))};}
   const availability=await(await fetch(baseUrl+'/api/model-availability')).json();assert.deepEqual(availability.models.map(x=>x.id),['deepseek-v4.1-flash','gpt-6.1-sol','gpt-6-luna','gpt-6-astra']);assert.equal(availability.contextWindow,256000);
   for(let i=0;i<3;i++){const response=await chat('gpt-6-astra');assert.equal(response.status,200);assert.ok(response.events.some(x=>x.type==='done'&&!x.degraded),response.raw.slice(-3000));}
   assert.equal((await dbGet(db,"SELECT count(*) AS n FROM chat_model_turns WHERE model_id='gpt-6-astra' AND status='completed'")).n,3);
   const before=observations.length,blocked=await chat('gpt-6-astra');assert.equal(blocked.status,429);assert.equal(JSON.parse(blocked.raw).code,'model_chat_quota_exceeded');assert.equal(observations.length,before,'quota cannot issue provider request');
   const luna=await chat('gpt-6-luna',{thinkingMode:false});assert.ok(luna.events.some(x=>x.type==='done'&&!x.degraded),luna.raw.slice(-2000));assert.equal(observations.filter(x=>x.body.model==='gpt-6-luna').at(-1).body.reasoning_effort,'low');
   // Vision stays on the explicitly selected DeepSeek model.
   const vision=await chat('deepseek-v4.1-flash',{messages:[{role:'user',content:'Read this image.',attachments:[{type:'image',data:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/yUAAAAASUVORK5CYII=',mimeType:'image/png',fileName:'pixel.png'}]}]});assert.ok(vision.events.some(x=>x.type==='model_info'&&x.model==='deepseek-v4.1-flash'),vision.raw.slice(-2000));assert.ok(observations.at(-1).body.messages.some(m=>Array.isArray(m.content)&&m.content.some(x=>x.type==='image_url')),'vision preserved');
   const history=Array.from({length:18},(_,i)=>({role:i%2?'assistant':'user',content:'Old fact '+i+' '+ '中'.repeat(9000)}));history.push({role:'user',content:'LATEST_USER_QUESTION'});
   const compressed=await chat('gpt-6.1-sol',{messages:history});assert.ok(compressed.events.some(x=>x.type==='context_compressed'),compressed.raw.slice(-4000)+'\n'+logs.slice(-18000));assert.ok(compressed.events.some(x=>x.type==='done'&&!x.degraded),compressed.raw.slice(-3000));assert.ok(summaryCalls>0);const last=observations.filter(x=>x.body.model==='gpt-6.1-sol').at(-1).body;assert.ok(last.messages.some(x=>x.content==='LATEST_USER_QUESTION'));assert.equal((await dbGet(db,"SELECT count(*) AS n FROM chat_model_turns WHERE model_id='gpt-6.1-sol' AND status='completed'")).n,1);
   // Actual provider ID is terminal metadata and SQLite history, not the selection alias.
   const user=await dbGet(db,'SELECT id FROM users LIMIT 1'),provenanceChat='provenance-'+crypto.randomBytes(12).toString('hex');
   await dbRun(db,'INSERT INTO sessions (id,user_id,title,model) VALUES (?,?,?,?)',[provenanceChat,user.id,'Provenance fixture','auto']);
   const smart=await chat('auto',{sessionId:provenanceChat,thinkingMode:false});
   assert.ok(smart.events.some(x=>x.type==='model_info'&&x.actualModel==='gpt-6.1-sol'),smart.raw.slice(-2000));
   assert.equal(smart.events.find(x=>x.type==='done').actualModel,'gpt-6.1-sol');
   assert.equal((await dbGet(db,"SELECT model FROM messages WHERE session_id=? AND role='assistant' ORDER BY id DESC LIMIT 1",[provenanceChat])).model,'gpt-6.1-sol');
   mode='failure';const failed=await chat('gpt-6.1-sol');assert.ok(failed.events.some(x=>x.type==='error'),failed.raw.slice(-3000));assert.equal((await dbGet(db,"SELECT count(*) AS n FROM chat_model_turns WHERE model_id='gpt-6.1-sol' AND status='completed'")).n,2);mode='answer';
   // The failed upstream trips its circuit: user still selects Sol, actual answer uses DeepSeek.
   const rerouted=await chat('gpt-6.1-sol',{sessionId:provenanceChat,thinkingMode:false});
   const terminalModel=rerouted.events.find(x=>x.type==='done')?.actualModel;
   assert.equal(terminalModel,'deepseek-v4.1-flash',rerouted.raw.slice(-2000));
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
   mode='remote';const stream=chat('gpt-6.1-sol',{sessionId:remoteChat,messages:[{role:'user',content:'List the files on my connected computer.'}],local_agent:{protocolVersion:'cx-online-v1',sessionId:link.id}});
   let remoteTask;
   for(let i=0;i<250&&!remoteTask;i++){remoteTask=(await remote(devicePath+'/poll','GET',undefined,deviceHeaders)).tasks[0];if(!remoteTask)await delay(100);}
   assert.ok(remoteTask,'chat must dispatch the remote tool');assert.equal(remoteTask.tool,'list_files');
   await remote(devicePath+'/tasks/'+remoteTask.id+'/start','POST',{},deviceHeaders);
   await remote(devicePath+'/tasks/'+remoteTask.id+'/result','POST',{result:{success:true,path:'fixture',entries:[{name:'remote-note.txt',type:'file'}],output:'目录: fixture (1 项)\n  [文件] remote-note.txt'}},deviceHeaders);
   const completed=await stream;assert.ok(completed.events.some(x=>x.type==='done'&&!x.degraded),completed.raw.slice(-4000));
   assert.ok(observations.some(x=>x.body.stream===true&&x.body.messages.some(m=>m.role==='tool'&&String(m.content).includes('remote-note.txt'))),'PC result must reach streaming provider continuation (exclude later title generation)');
   assert.ok(!completed.events.some(x=>x.type==='local_agent_tool_call'||x.type==='client_tool_call'),'Web must not execute desktop tool payload');
   await remote(devicePath,'DELETE',undefined,deviceHeaders);mode='answer';
   console.log('chat-model-runtime PASS: authenticated free account, 3 completed Astra turns then 429, zero points, Luna effort, native DeepSeek vision, failure release, real long-context summarization, independent model allowances');
  }finally{await closeDatabase(db);}
 }catch(error){error.message+='\nIsolated server tail:\n'+logs.slice(-9000);throw error;}finally{if(child&&child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),delay(8000)]);if(child.exitCode===null)child.kill('SIGKILL');}provider.closeAllConnections?.();await new Promise(r=>provider.close(r));const safe=fs.realpathSync(temp),base=fs.realpathSync(os.tmpdir());assert.ok(safe.startsWith(base+path.sep)&&path.basename(safe).startsWith('rai-model-runtime-'));fs.rmSync(safe,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
