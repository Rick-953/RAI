'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const express = require('express'); const sqlite3 = require('sqlite3');
const { installSecureSharingRoutes } = require('../lib/secure-sharing-routes');
async function main() {
 const filename = path.join(os.tmpdir(), 'rai-share-test-' + require('node:crypto').randomUUID() + '.db');
 const db = new sqlite3.Database(filename);
 const run = (sql,args=[]) => new Promise((resolve,reject)=>db.run(sql,args,function(e){e?reject(e):resolve(this);}));
 const get = (sql,args=[]) => new Promise((resolve,reject)=>db.get(sql,args,(e,r)=>e?reject(e):resolve(r)));
 const all = (sql,args=[]) => new Promise((resolve,reject)=>db.all(sql,args,(e,r)=>e?reject(e):resolve(r)));
 let server, issued=0; const events=[];
 try {
  await run('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, email_verified INTEGER)');
  await run('CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id INTEGER, title TEXT)');
  await run('CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, created_at INTEGER)');
  await run('CREATE TABLE auth_sessions (session_id TEXT PRIMARY KEY, user_id INTEGER, revoked_at INTEGER, expires_at INTEGER)');
  await run("INSERT INTO users VALUES (1,'test@example.invalid',1)");
  await run("INSERT INTO auth_sessions VALUES ('phone',1,NULL,?)",[Date.now()+60000]);
  await run("INSERT INTO sessions VALUES ('owned',1,'Test'),('other',2,'Private')");
  await run("INSERT INTO messages VALUES (1,'owned','user','hello',1),(2,'owned','assistant','<script>private code</script>',2),(3,'owned','tool','do not share tools',3),(4,'owned','system','do not share system',4)");
  const app=express();app.use(express.json());
  const pass=(_q,_s,next)=>next();
  const auth=(req,res,next)=>{if(req.headers.authorization!=='Bearer phone-test')return res.status(401).json({error:'unauthorized'});req.user={userId:1,sid:'phone'};next();};
  installSecureSharingRoutes({app,authenticateToken:auth,authLimiter:pass,apiLimiter:pass,dbRunAsync:run,dbGetAsync:get,dbAllAsync:all,authSessionStartupReady:Promise.resolve(),allowedCorsOrigins:new Set(['https://rai.test']),buildAuthSessionDeviceMetadata:()=>({osName:'Windows',browserName:'CX RAI'}),buildAuthenticatedUserPayload:async user=>{issued++;return {success:true,token:'test-access',user:{id:user.id}};},audit:(event,meta)=>events.push({event,meta})});
  server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const base='http://127.0.0.1:'+server.address().port;
  async function call(url,body={},authorized=false,method='POST',host='rai.test') {
    const r=await fetch(base+url,{method,headers:{Host:host,'Content-Type':'application/json',...(authorized?{Authorization:'Bearer phone-test'}:{})},body:JSON.stringify(body)});
    assert.equal(r.headers.get('cache-control'),'no-store');return {status:r.status,data:await r.json()};
  }
  let created=(await call('/api/auth/qr/create')).data;
  const owner={id:created.id,ownerSecret:created.ownerSecret};
  assert.equal((await call('/api/auth/qr/poll',{id:created.id,ownerSecret:'bad'})).status,404);
  assert.equal((await call('/api/auth/qr/image',owner,false,'POST','evil.invalid')).status,403);
  const image=(await call('/api/auth/qr/image',owner)).data;assert.match(image.image,/^data:image\/png;base64,/);
  const scanToken=image.scanPath.split('.').pop();
  assert.equal((await call('/api/auth/qr/claim',{id:created.id,scanToken})).status,401);
  const claim=(await call('/api/auth/qr/claim',{id:created.id,scanToken},true)).data;
  assert.equal(claim.code,created.code);assert.equal(claim.ownerSecret,undefined);
  assert.equal((await call('/api/auth/qr/consume',owner)).status,409);
  assert.equal((await call('/api/auth/qr/confirm',{id:created.id,approvalSecret:claim.approvalSecret,approve:true},true)).status,200);
  assert.equal((await call('/api/auth/qr/consume',owner)).data.token,'test-access');assert.equal(issued,1);
  assert.equal((await call('/api/auth/qr/consume',owner)).status,410);
  created=(await call('/api/auth/qr/create')).data;
  const revokedOwner={id:created.id,ownerSecret:created.ownerSecret};
  const revokedClaim=(await call('/api/auth/qr/claim',{id:created.id,scanToken:created.scanPath.split('.').pop()},true)).data;
  await call('/api/auth/qr/confirm',{id:created.id,approvalSecret:revokedClaim.approvalSecret,approve:true},true);
  await run("UPDATE auth_sessions SET revoked_at=? WHERE session_id='phone'",[Date.now()]);
  assert.equal((await call('/api/auth/qr/consume',revokedOwner)).status,403);assert.equal(issued,1);
  assert.equal((await call('/api/sessions/other/share',{},true)).status,404);
  const share=(await call('/api/sessions/owned/share',{},true)).data;
  assert.match(share.key,/^[A-Za-z0-9_-]{43}$/);
  const snapshot=(await call('/api/shares/read',{key:share.key})).data;
  assert.equal(snapshot.messages.length,2);assert.equal(snapshot.messages[1].content,'<script>private code</script>');
  await call('/api/sessions/owned/share',{},true,'DELETE');
  assert.equal((await call('/api/shares/read',{key:share.key})).status,404);
  const next=(await call('/api/sessions/owned/share',{},true)).data;
  await run("DELETE FROM sessions WHERE id='owned'");
  assert.equal((await call('/api/shares/read',{key:next.key})).status,404);
  const logged=JSON.stringify(events);for(const secret of [owner.ownerSecret,scanToken,claim.approvalSecret,share.key,'test-access','test@example.invalid'])assert.ok(!logged.includes(secret));
  console.log('secure-sharing runtime PASS: HTTP ownership, QR image, host validation, auth, explicit approval, one-time consumption, session revocation, snapshot isolation/revocation, private logging');
 } finally { if(server)await new Promise(r=>server.close(r));await new Promise(r=>db.close(r));fs.unlinkSync(filename); }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
