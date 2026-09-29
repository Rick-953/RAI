'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const express = require('express'); const sqlite3 = require('sqlite3');
const { installSecureSharingRoutes } = require('../lib/secure-sharing-routes');
const { createAuthSessionStore } = require('../lib/auth-session-store');
const QRCode = require('qrcode');
const originalRender = QRCode.toDataURL; let qrPayload;
QRCode.toDataURL = async (data, options) => { qrPayload = data; return originalRender(data, options); };
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
  const store = createAuthSessionStore({ db, jwtSecret: require('node:crypto').randomBytes(48), refreshPepper: require('node:crypto').randomBytes(48), production: true });
  await store.migrate();
  await run("INSERT INTO users (id,email,email_verified) VALUES (1,'test@example.invalid',1)");
  let phone = await store.createSession({ userId: 1, authMethod: 'password+totp', authTime: Math.floor(Date.now()/1000)-1800 });
  await run("INSERT INTO sessions VALUES ('owned',1,'Test'),('other',2,'Private')");
  await run("INSERT INTO messages VALUES (1,'owned','user','hello',1),(2,'owned','assistant','<script>private code</script>',2),(3,'owned','tool','do not share tools',3),(4,'owned','system','do not share system',4)");
  const app=express();app.use(express.json());
  const pass=(_q,_s,next)=>next();
  const auth=async(req,res,next)=>{try { req.user=await store.verifyAccessToken(String(req.headers.authorization||'').replace(/^Bearer /,'')); next(); } catch (_) { res.status(401).json({error:'unauthorized'}); }};
  installSecureSharingRoutes({app,authenticateToken:auth,authLimiter:pass,apiLimiter:pass,dbRunAsync:run,dbGetAsync:get,dbAllAsync:all,authSessionStartupReady:Promise.resolve(),allowedCorsOrigins:new Set(['https://rai.test']),publicBaseUrl:'https://rai.test/beta',buildAuthSessionDeviceMetadata:()=>({osName:'Windows',browserName:'CX RAI'}),buildAuthenticatedUserPayload:async(user,req,fingerprint,claims,options)=>{const session=await store.createSession({userId:user.id,authMethod:claims.auth_method,...options}); issued++;return {success:true,token:session.accessToken,user:{id:user.id}};},audit:(event,meta)=>events.push({event,meta})});
  server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const base='http://127.0.0.1:'+server.address().port;
  async function call(url,body={},authorized=false,method='POST',host='rai.test') {
    return new Promise((resolve,reject)=>{
      const data=JSON.stringify(body);
      const req=require('node:http').request(base+url,{method,headers:{Host:host,'Content-Type':'application/json','Content-Length':Buffer.byteLength(data),...(authorized?{Authorization:'Bearer '+phone.accessToken}:{})}},res=>{
        let output='';res.setEncoding('utf8');res.on('data',chunk=>output+=chunk);res.on('end',()=>{
          try { assert.equal(res.headers['cache-control'],'no-store');resolve({status:res.statusCode,data:JSON.parse(output)}); } catch(e){reject(e);}
        });
      });req.on('error',reject);req.end(data);
    });
  }
  let created=(await call('/api/auth/qr/create')).data;
  const owner={id:created.id,ownerSecret:created.ownerSecret};
  assert.equal((await call('/api/auth/qr/poll',{id:created.id,ownerSecret:'bad'})).status,404);
  assert.equal((await call('/api/auth/qr/image',owner,false,'POST','evil.invalid')).status,403);
  const image=(await call('/api/auth/qr/image',owner)).data;assert.match(image.image,/^data:image\/png;base64,/);
  assert.match(qrPayload, /^https:\/\/rai\.test\/beta\/qr-login\.html#[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(new URL(qrPayload).pathname, '/beta/qr-login.html');
  const scanToken=image.scanPath.split('.').pop();
  assert.equal((await call('/api/auth/qr/claim',{id:created.id,scanToken})).status,401);
  const claim=(await call('/api/auth/qr/claim',{id:created.id,scanToken},true)).data;
  assert.equal(claim.code,created.code);assert.equal(claim.ownerSecret,undefined);
  assert.equal((await call('/api/auth/qr/consume',owner)).status,409);
  assert.equal((await call('/api/auth/qr/confirm',{id:created.id,approvalSecret:claim.approvalSecret,approve:true},true)).status,200);
  const consumed = await call('/api/auth/qr/consume',owner);
  assert.equal(consumed.status,200);
  const decoded = await store.verifyAccessToken(consumed.data.token);
  assert.equal(decoded.auth_time,phone.authTime,'QR must not renew the password/MFA authentication age');
  assert.equal(issued,1);
  assert.equal((await call('/api/auth/qr/consume',owner)).status,410);
  created=(await call('/api/auth/qr/create')).data;
  const revokedOwner={id:created.id,ownerSecret:created.ownerSecret};
  const revokedClaim=(await call('/api/auth/qr/claim',{id:created.id,scanToken:created.scanPath.split('.').pop()},true)).data;
  await call('/api/auth/qr/confirm',{id:created.id,approvalSecret:revokedClaim.approvalSecret,approve:true},true);
  await run('UPDATE auth_sessions SET revoked_at=? WHERE session_id=?',[Math.floor(Date.now()/1000),phone.sessionId]);
  assert.equal((await call('/api/auth/qr/consume',revokedOwner)).status,403);assert.equal(issued,1);
  for (const invalidation of ['version', 'expiry']) {
    phone = await store.createSession({ userId: 1, authMethod: 'password+totp' });
    const pending = (await call('/api/auth/qr/create')).data;
    const proof = (await call('/api/auth/qr/claim',{id:pending.id,scanToken:pending.scanPath.split('.').pop()},true)).data;
    assert.equal((await call('/api/auth/qr/confirm',{id:pending.id,approvalSecret:proof.approvalSecret,approve:true},true)).status,200);
    if (invalidation === 'version') await run('UPDATE users SET session_version=session_version+1 WHERE id=1');
    else await run('UPDATE auth_sessions SET expires_at=? WHERE session_id=?',[Math.floor(Date.now()/1000)-1,phone.sessionId]);
    assert.equal((await call('/api/auth/qr/consume',{id:pending.id,ownerSecret:pending.ownerSecret})).status,403);
    assert.equal(issued,1);
  }
  phone = await store.createSession({ userId: 1 });
  assert.equal((await call('/api/sessions/other/share',{},true)).status,404);
  const share=(await call('/api/sessions/owned/share',{},true)).data;
  assert.match(share.key,/^[A-Za-z0-9_-]{43}$/);
  assert.equal(share.sharePath, '/beta/share.html#'+share.key);
  const snapshot=(await call('/api/shares/read',{key:share.key})).data;
  assert.equal(snapshot.messages.length,2);assert.equal(snapshot.messages[1].content,'<script>private code</script>');
  await call('/api/sessions/owned/share',{},true,'DELETE');
  assert.equal((await call('/api/shares/read',{key:share.key})).status,404);
  const next=(await call('/api/sessions/owned/share',{},true)).data;
  await run("DELETE FROM sessions WHERE id='owned'");
  assert.equal((await call('/api/shares/read',{key:next.key})).status,404);
  const logged=JSON.stringify(events);for(const secret of [owner.ownerSecret,scanToken,claim.approvalSecret,share.key,consumed.data.token,'test@example.invalid'])assert.ok(!logged.includes(secret));
  console.log('secure-sharing runtime PASS: HTTP ownership, QR image, host validation, auth, explicit approval, one-time consumption, session revocation, snapshot isolation/revocation, private logging, real auth-session schema, expiry seconds, account version, inherited auth_time, beta paths');
 } finally { QRCode.toDataURL=originalRender; if(server)await new Promise(r=>server.close(r));await new Promise(r=>db.close(r));fs.unlinkSync(filename); }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
