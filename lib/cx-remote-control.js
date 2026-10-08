'use strict';
const crypto = require('node:crypto');
const DEVICE_LEASE_MS=45000, SESSION_MS=15*60*1000, APPROVAL_MS=60000, JOB_MS=5*60*1000;
const TOOLS=Object.freeze(['list_files','read_file','write_file','transform_file','edit_file','create_artifact','sandbox_exec','copy_file','move_file','delete_file','insert_image','update_sheet']);
function failure(code,status=409){const e=new Error(code);e.code=code;e.status=status;return e;}
function id(prefix){return prefix+'_'+crypto.randomBytes(24).toString('base64url');}
function installCxRemoteRoutes({app,authenticateToken,apiLimiter,dbGet,now=Date.now}) {
 const devices=new Map(), sessions=new Map(), jobs=new Map();
 const hash=value=>crypto.createHash('sha256').update(String(value||'')).digest();
 const same=(a,b)=>crypto.timingSafeEqual(hash(a),hash(b));
 const publicDevice=d=>({id:d.id,name:d.name,version:d.version,online:d.lastSeen>now()-DEVICE_LEASE_MS,platform:'windows',capabilities:TOOLS});
 function prune(){
  for(const [key,j] of jobs)if(j.expires<=now()){j.resolve?.({success:false,error:'cx_remote_task_expired'});jobs.delete(key);}
  for(const [key,s] of sessions)if(s.expires<=now()||(s.status==='pending'&&s.approvalExpires<=now())){revokeSession(s);sessions.delete(key);}
  for(const [key,d] of devices)if(d.lastSeen<=now()-DEVICE_LEASE_MS){for(const s of sessions.values())if(s.deviceId===key)revokeSession(s);devices.delete(key);}
 }
 function ownSession(userId,sessionId,conversationId){prune();const s=sessions.get(sessionId);if(!s||s.userId!==userId||s.status==='revoked'||s.status==='rejected')throw failure('cx_remote_session_unavailable',403);if(conversationId!==undefined&&s.conversationId!==conversationId)throw failure('cx_remote_conversation_mismatch',403);return s;}
 function nativeDevice(req){prune();if(!req.softwareClient)throw failure('software_client_key_required',403);const d=devices.get(req.params.deviceId);if(!d||d.userId!==req.user.userId||!same(d.secret,req.get('X-CX-Device-Key')))throw failure('cx_remote_device_unavailable',403);return d;}
 function revokeSession(s){s.status='revoked';sessions.delete(s.id);for(const j of jobs.values())if(j.sessionId===s.id)j.resolve?.({success:false,error:'cx_remote_connection_revoked'});}
 function endpoint(fn){return async(req,res)=>{res.set('Cache-Control','no-store');try{prune();await fn(req,res);}catch(e){res.status(e.status||500).json({success:false,error:e.code||'cx_remote_failed'});}};}
 const route=(method,path,fn)=>app[method](path,apiLimiter,authenticateToken,endpoint(fn));
 route('post','/api/cx-remote/devices',async(req,res)=>{
  if(!req.softwareClient)throw failure('software_client_key_required',403);
  if(req.body.platform!=='windows')throw failure('cx_remote_desktop_only',400);
  if(devices.size>=256||[...devices.values()].filter(d=>d.userId===req.user.userId).length>=5)throw failure('cx_remote_device_limit',429);
  const d={id:id('cx'),secret:crypto.randomBytes(32).toString('base64url'),userId:req.user.userId,name:String(req.body.name||'CX RAI PC').replace(/[\u0000-\u001f]/g,'').slice(0,80),version:String(req.body.version||'').slice(0,30),lastSeen:now()};devices.set(d.id,d);res.json({success:true,device:{...publicDevice(d),deviceKey:d.secret}});
 });
 route('get','/api/cx-remote/devices',async(req,res)=>res.json({success:true,devices:[...devices.values()].filter(d=>d.userId===req.user.userId).map(publicDevice)}));
 route('delete','/api/cx-remote/devices/:deviceId',async(req,res)=>{const d=devices.get(req.params.deviceId);if(!d||d.userId!==req.user.userId)throw failure('cx_remote_device_unavailable',404);if(req.softwareClient)nativeDevice(req);for(const s of sessions.values())if(s.deviceId===d.id)revokeSession(s);devices.delete(d.id);res.json({success:true});});
 route('post','/api/cx-remote/sessions',async(req,res)=>{
  const d=devices.get(req.body.deviceId);if(!d||d.userId!==req.user.userId)throw failure('cx_remote_device_unavailable',404);
  const conversationId=String(req.body.conversationId||'');const conversation=await dbGet('SELECT id FROM sessions WHERE id = ? AND user_id = ?',[conversationId,req.user.userId]);if(!conversation)throw failure('cx_remote_conversation_unavailable',404);
  if(sessions.size>=2048)throw failure('cx_remote_session_limit',429);
  if([...sessions.values()].filter(s=>s.userId===req.user.userId&&s.status!=='revoked').length>=8)throw failure('cx_remote_session_limit',429);
  const s={id:id('cxs'),deviceId:d.id,userId:req.user.userId,conversationId,status:'pending',expires:now()+SESSION_MS,approvalExpires:now()+APPROVAL_MS,code:crypto.randomBytes(3).toString('hex').toUpperCase(),requester:String(req.get('User-Agent')||'Web').slice(0,180)};sessions.set(s.id,s);res.json({success:true,session:{id:s.id,conversationId,status:s.status,expiresAt:s.expires,confirmationCode:s.code}});
 });
 route('get','/api/cx-remote/sessions/:sessionId',async(req,res)=>{const s=ownSession(req.user.userId,req.params.sessionId);res.json({success:true,session:{id:s.id,conversationId:s.conversationId,status:s.status,expiresAt:s.expires,confirmationCode:s.code}});});
 route('delete','/api/cx-remote/sessions/:sessionId',async(req,res)=>{const s=ownSession(req.user.userId,req.params.sessionId);revokeSession(s);res.json({success:true});});
 route('get','/api/cx-remote/devices/:deviceId/poll',async(req,res)=>{
  const d=nativeDevice(req);d.lastSeen=now();
  const own=[...sessions.values()].filter(s=>s.deviceId===d.id&&!['rejected','revoked'].includes(s.status));
  const approvals=own.filter(s=>s.status==='pending').map(s=>({id:s.id,conversationId:s.conversationId,code:s.code,expiresAt:s.approvalExpires,requester:s.requester}));
  const task=[...jobs.values()].find(j=>j.deviceId===d.id&&j.status==='queued');let tasks=[];
  if(task&&req.query.busy!=='1'&&approvals.length===0){task.status='delivered';tasks=[{id:task.id,sessionId:task.sessionId,tool:task.tool,parameters:task.parameters,expiresAt:task.expires,confirmationCode:sessions.get(task.sessionId)?.code}];}
  res.json({success:true,approvals,tasks,activeSessionIds:own.filter(s=>s.status==='approved').map(s=>s.id),activeJobIds:[...jobs.values()].filter(j=>j.deviceId===d.id).map(j=>j.id)});
 });
 route('post','/api/cx-remote/devices/:deviceId/approve',async(req,res)=>{
  const d=nativeDevice(req),s=ownSession(req.user.userId,req.body.sessionId);if(s.deviceId!==d.id||s.status!=='pending')throw failure('cx_remote_approval_unavailable');s.status=req.body.approved===true?'approved':'rejected';res.json({success:true});
 });
 route('post','/api/cx-remote/devices/:deviceId/tasks/:jobId/start',async(req,res)=>{
  const d=nativeDevice(req),j=jobs.get(req.params.jobId);if(!j||j.deviceId!==d.id||j.status!=='delivered')throw failure('cx_remote_task_unavailable');const s=ownSession(req.user.userId,j.sessionId);if(s.status!=='approved')throw failure('cx_remote_connection_not_approved',403);j.status='running';res.json({success:true});
 });
 route('post','/api/cx-remote/devices/:deviceId/tasks/:jobId/result',async(req,res)=>{
  const d=nativeDevice(req),j=jobs.get(req.params.jobId);if(!j||j.deviceId!==d.id||!['delivered','running'].includes(j.status))throw failure('cx_remote_task_unavailable');ownSession(req.user.userId,j.sessionId);if(j.status==='delivered'&&req.body.result?.success!==false)throw failure('cx_remote_start_required',403);const serialized=JSON.stringify(req.body.result||{});if(Buffer.byteLength(serialized)>128*1024)throw failure('cx_remote_result_too_large',413);j.status='completed';j.resolve?.(req.body.result||{});res.json({success:true});
 });
 function resolveChatSession(userId,input,conversationId){if(!input)return null;if(input.protocolVersion!=='cx-online-v1')return null;const s=ownSession(userId,input.sessionId,conversationId);if(s.status!=='approved')throw failure('cx_remote_connection_not_approved',403);return {...s,platform:'windows'};}
 async function execute(userId,sessionId,conversationId,tool,parameters,signal){
  const s=ownSession(userId,sessionId,conversationId);if(s.status!=='approved')throw failure('cx_remote_connection_not_approved',403);
  if(!TOOLS.includes(tool))throw failure('cx_remote_tool_not_supported',400);
  if(signal?.aborted)throw failure('cx_remote_request_cancelled');
  if(Buffer.byteLength(JSON.stringify(parameters||{}))>64*1024)throw failure('cx_remote_parameters_too_large',413);
  if(jobs.size>=256)throw failure('cx_remote_job_limit',429);
  if([...jobs.values()].some(j=>j.deviceId===s.deviceId&&!['completed','cancelled'].includes(j.status)))throw failure('cx_remote_device_busy',409);
  const j={id:id('cxj'),deviceId:s.deviceId,userId,sessionId:s.id,tool,parameters,status:'queued',expires:now()+JOB_MS};jobs.set(j.id,j);
  return new Promise(resolve=>{
   const timer=setTimeout(()=>finish({success:false,error:'cx_remote_task_expired'}),JOB_MS);
   const abort=()=>finish({success:false,error:'cx_remote_request_cancelled'});
   function finish(value){clearTimeout(timer);signal?.removeEventListener('abort',abort);if(j.status!=='completed'){j.status='cancelled';j.parameters={};}j.resolve=null;j.parameters={};jobs.delete(j.id);resolve(value);}
   j.resolve=finish;signal?.addEventListener('abort',abort,{once:true});
  });
 }
 return {resolveChatSession,execute,devices,sessions,jobs,prune};
}
module.exports={installCxRemoteRoutes,TOOLS,DEVICE_LEASE_MS,SESSION_MS};
