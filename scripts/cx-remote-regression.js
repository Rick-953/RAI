'use strict';
// Actual HTTP transport, randomized isolated identities, deterministic lease clock.
const assert=require('node:assert/strict'),crypto=require('node:crypto'),express=require('express');
const {installCxRemoteRoutes,DEVICE_LEASE_MS,APPROVAL_MS}=require('../lib/cx-remote-control');
(async()=>{
 const app=express();app.use(express.json({limit:'256kb'}));let now=Date.now();
 const user=crypto.randomBytes(32).toString('hex'),other=crypto.randomBytes(32).toString('hex'),software=crypto.randomBytes(32).toString('hex');
 const authenticateToken=(req,res,next)=>{const t=req.get('Authorization');if(![user,other].includes(t))return res.sendStatus(401);req.user={userId:t===user?1:2,sid:t===user?'web-login-1':'web-login-2'};req.softwareClient=req.get('X-RAI-Client-Key')===software?{platform:'windows'}:null;next();};
 const service=installCxRemoteRoutes({app,authenticateToken,isLoginSessionActive:async()=>true,apiLimiter:(req,res,next)=>next(),dbGet:async(sql,p)=>p[0]==='owned-chat'&&p[1]===1?{id:p[0]}:null,now:()=>now});
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});const base='http://127.0.0.1:'+server.address().port+'/api/cx-remote';
 async function req(path,method='GET',body,headers={}){const r=await fetch(base+path,{method,headers:{Authorization:user,'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});let data;try{data=await r.json();}catch{}return{status:r.status,...data};}
 const native={'X-RAI-Client-Key':software};
 try{
  assert.equal((await req('/devices','POST',{platform:'windows'})).status,403);
  assert.equal((await req('/devices','POST',{platform:'windows'},{Authorization:''})).status,401);
  const d=(await req('/devices','POST',{platform:'windows',name:'Test PC',version:'1.8.7'},native)).device;assert.ok(d.deviceKey);
  const path='/devices/'+d.id,device={...native,'X-CX-Device-Key':d.deviceKey};
  assert.equal((await req('/devices',undefined,undefined,{Authorization:other})).devices.length,0);
  assert.equal(JSON.stringify(await req('/devices')).includes(d.deviceKey),false);
  assert.equal((await req(path+'/poll')).status,403);
  assert.equal((await req(path+'/poll','GET',undefined,{...native,'X-CX-Device-Key':'bad'})).status,403);
  assert.equal((await req(path+'/poll','GET',undefined,{...device,Authorization:other})).status,403);
  assert.equal((await req('/sessions','POST',{deviceId:d.id,conversationId:'not-owned'})).status,404);
  assert.equal((await req('/sessions','POST',{deviceId:d.id,conversationId:'owned-chat'},{Authorization:other})).status,404);
  async function session(approve=true){const s=(await req('/sessions','POST',{deviceId:d.id,conversationId:'owned-chat'})).session;if(approve)assert.equal((await req(path+'/approve','POST',{sessionId:s.id,approved:true},device)).status,200);return s;}
  const s=await session(false);
  assert.throws(()=>service.resolveChatSession(1,{protocolVersion:'cx-online-v1',sessionId:s.id},'owned-chat'),/not_approved/);
  assert.equal((await req(path+'/approve','POST',{sessionId:s.id,approved:true})).status,403);
  assert.equal((await req(path+'/poll','GET',undefined,device)).approvals[0].code,s.confirmationCode);
  assert.equal((await req(path+'/approve','POST',{sessionId:s.id,approved:true},device)).status,200);
  assert.throws(()=>service.resolveChatSession(2,{protocolVersion:'cx-online-v1',sessionId:s.id},'owned-chat'),/unavailable/);
  assert.throws(()=>service.resolveChatSession(1,{protocolVersion:'cx-online-v1',sessionId:s.id},'other-chat'),/mismatch/);
  assert.equal((await req(path+'/approve','POST',{sessionId:s.id,approved:true},device)).status,409);
  await assert.rejects(service.execute(1,s.id,'owned-chat','browser_exec',{}),/not_supported/);
  await assert.rejects(service.execute(1,s.id,'owned-chat','read_file',{x:'x'.repeat(66000)}),/too_large/);
  const result=service.execute(1,s.id,'owned-chat','write_file',{path:'test.txt',content:'isolated'});
  await assert.rejects(service.execute(1,s.id,'owned-chat','read_file',{}),/busy/);
  assert.equal((await req(path+'/poll?busy=1','GET',undefined,device)).tasks.length,0);
  const task=(await req(path+'/poll','GET',undefined,device)).tasks[0];assert.ok(task);
  assert.equal((await req(path+'/poll','GET',undefined,device)).tasks.length,0,'no task replay');
  assert.equal((await req(path+'/tasks/'+task.id+'/result','POST',{result:{success:true}},device)).status,403,'must start before effects');
  assert.equal((await req(path+'/tasks/'+task.id+'/start','POST',{},device)).status,200);
  assert.equal((await req(path+'/tasks/'+task.id+'/start','POST',{},device)).status,409);
  assert.equal((await req(path+'/tasks/'+task.id+'/result','POST',{result:{success:true,x:'x'.repeat(132000)}},device)).status,413);
  assert.equal((await req(path+'/tasks/'+task.id+'/result','POST',{result:{success:true,file_name:'test.txt'}},device)).status,200);
  assert.equal((await result).success,true);assert.equal(service.jobs.size,0,'no result/file-content retention');
  assert.equal((await req(path+'/tasks/'+task.id+'/result','POST',{result:{success:true}},device)).status,409);
  const cancelled=new AbortController(),pending=service.execute(1,s.id,'owned-chat','read_file',{},cancelled.signal);await new Promise(setImmediate);cancelled.abort();assert.equal((await pending).error,'cx_remote_request_cancelled');assert.equal(service.jobs.size,0);
  const revoked=service.execute(1,s.id,'owned-chat','read_file',{});await new Promise(setImmediate);await req('/sessions/'+s.id,'DELETE');assert.equal((await revoked).error,'cx_remote_connection_revoked');assert.equal(service.jobs.size,0);
  const rejected=await session(false);await req(path+'/approve','POST',{sessionId:rejected.id,approved:false},device);assert.throws(()=>service.resolveChatSession(1,{protocolVersion:'cx-online-v1',sessionId:rejected.id},'owned-chat'),/unavailable/);
  const late=await session(false);now+=APPROVAL_MS+1; // refresh lease directly only to isolate approval expiry
  service.devices.get(d.id).lastSeen=now;assert.equal((await req(path+'/approve','POST',{sessionId:late.id,approved:true},device)).status,403);
  const alive=await session();const offline=service.execute(1,alive.id,'owned-chat','read_file',{});await new Promise(setImmediate);now+=DEVICE_LEASE_MS+1;service.prune();assert.equal((await offline).error,'cx_remote_connection_revoked');assert.equal((await req(path+'/poll','GET',undefined,device)).status,403);
  console.log('cx-remote PASS: actor/device isolation, approval, conversation scope, one-shot execution, busy, bounds, abort, replay, expiry, offline revocation, no result retention');
 }finally{for(const s of service.sessions.values())await req('/sessions/'+s.id,'DELETE');service.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
