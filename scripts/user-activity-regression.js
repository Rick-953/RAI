'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const sqlite3 = require('sqlite3');
const { createAuthSessionStore } = require('../lib/auth-session-store');
const { createUserActivity, normalizeEvent } = require('../lib/user-activity');
const { requestDiagnostics } = require('../lib/request-diagnostics');
const createClient = require('../public/user-activity');
const { createChatLatencyTrace, fetchWithLatency } = require('../lib/chat-latency');
async function main() {
  const db = new sqlite3.Database(':memory:');
  const run = (sql,args=[]) => new Promise((resolve,reject) => db.run(sql,args,function(error) { error ? reject(error) : resolve(this); }));
  const get = (sql,args=[]) => new Promise((resolve,reject) => db.get(sql,args,(error,row) => error ? reject(error) : resolve(row)));
  const all = (sql,args=[]) => new Promise((resolve,reject) => db.all(sql,args,(error,rows) => error ? reject(error) : resolve(rows)));
  let tail = Promise.resolve(), server;
  const transaction = operation => {
    const current = tail.then(async () => { await run('BEGIN IMMEDIATE'); try { const result = await operation({run,get,all}); await run('COMMIT'); return result; } catch(error) { await run('ROLLBACK'); throw error; } });
    tail = current.catch(() => {}); return current;
  };
  try {
    await run('CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, email TEXT, email_verified INTEGER)');
    await run('CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id INTEGER)');
    const auth = createAuthSessionStore({ db, jwtSecret: crypto.randomBytes(48), refreshPepper: crypto.randomBytes(48), production: true });
    await auth.migrate();
    await run("INSERT INTO users(id,username,email,email_verified) VALUES(1,'master tea','tea@example.invalid',1),(2,'second','second@example.invalid',1)");
    await run("INSERT INTO sessions VALUES('owned',1),('other',2)");
    const session = await auth.createSession({ userId:1 });
    const app = express(); app.set('trust proxy', false); app.use(express.json()); app.use(requestDiagnostics);
    app.use(rateLimit({ windowMs:60000, max:1000, validate:{trustProxy:false} }));
    const activity = createUserActivity({ dbRunAsync:run, dbAllAsync:all, withMainDbTransaction:transaction });
    await activity.ready;
    const authenticateToken = async (req,res,next) => { try { req.user = await auth.verifyAccessToken(String(req.headers.authorization || '').replace(/^Bearer /,'')); activity.bindRequest(req); next(); } catch (_) { res.sendStatus(401); } };
    const adminSecret = crypto.randomBytes(32).toString('hex');
    const authenticateAdmin = (req,res,next) => req.get('X-Admin-Token') === adminSecret ? next() : res.sendStatus(403);
    activity.install({ app, authenticateToken, authenticateAdmin });
    app.post('/api/trace-test', authenticateToken, (req,res) => res.status(503).json({ code:'upstream_interrupted' }));
    server = await new Promise(resolve => { const listening = app.listen(0,'127.0.0.1',() => resolve(listening)); });
    const base = 'http://127.0.0.1:' + server.address().port;
    const call = (path,body,headers={}) => fetch(base+path,{ method:body ? 'POST':'GET', headers:{ 'Content-Type':'application/json', ...headers }, ...(body ? {body:JSON.stringify(body)}:{}) });
    const bearer = { Authorization:'Bearer '+session.accessToken };
    // Auth store's public token name is shared with native/browser login results.
    if (!session.accessToken) bearer.Authorization = 'Bearer '+session.token;
    const event = { id:crypto.randomUUID(), timeMs:Date.now()-123, kind:'ui', action:'SendButton', sessionId:'owned',
      tokenUsage:{ provider:'openai_official', model:'gpt-6-luna', cacheTtl:'12h', input_tokens:12000, output_tokens:50, input_tokens_details:{cached_tokens:4000,cache_write_tokens:7000,cache_write_tokens_details:{ttl_30m_tokens:5000,ttl_12h_tokens:2000}}, total_cost:0.25,currency:'USD', text:'PRIVATE_BODY' },
      userId:2, network:{clientIp:'203.0.113.99'}, token:'PRIVATE_SECRET', message:'PRIVATE_BODY',
      context:{ timezone:'Asia/Shanghai', locale:'zh-CN', region:'CN', theme:'dark', selectedModel:'gpt-6-luna', reasoningProfile:'high', selectedSkills:['ponytail'], token:'PRIVATE_SECRET' } };
    assert.equal((await call('/api/user/activity',{ events:[event] })).status,401);
    assert.equal((await call('/api/user/activity',{ events:[event] },bearer)).status,200);
    assert.equal((await call('/api/user/activity',{ events:[event] },bearer)).status,200);
    assert.equal((await get('SELECT count(*) AS n FROM user_activity')).n,1,'retry has one durable row');
    assert.equal((await call('/api/user/activity',{ events:[{...event,id:crypto.randomUUID(),sessionId:'other'}] },bearer)).status,403);
    assert.equal((await call('/api/user/activity',{ events:[{...event,id:crypto.randomUUID()}, {...event,id:crypto.randomUUID(),timeMs:1.5}] },bearer)).status,400);
    assert.equal((await get('SELECT count(*) AS n FROM user_activity')).n,1,'invalid batch cannot partially commit');
    assert.equal((await call('/api/admin/user-activity',null,bearer)).status,403);
    const headers = { 'X-Admin-Token':adminSecret };
    let data = await (await call('/api/admin/user-activity?account=master%20tea',null,headers)).json();
    assert.equal(data.events.length,1);
    const saved = data.events[0];
    assert.equal(saved.userId,1); assert.equal(saved.timeMs,event.timeMs); assert.ok(Number.isSafeInteger(saved.receivedTimeMs));
    assert.equal(saved.sessionVerified,true); assert.equal(saved.context.reasoningProfile,'high');
    assert.equal(saved.tokenUsage.cacheReadTokens,4000); assert.equal(saved.tokenUsage.cacheWriteTokens,7000);
    assert.equal(saved.tokenUsage.cacheHitRate,1/3); assert.equal(saved.tokenUsage.estimatedUsd,0.00129);
    assert.equal(saved.tokenUsage.reportedCost,0.25); assert.equal(saved.tokenUsage.requestedRetentionSeconds,43200);
    assert.equal(saved.tokenUsage.actualCacheAgeSeconds,null);
    assert.equal(saved.network.clientIp,'127.0.0.1'); assert.ok(!JSON.stringify(data).includes('PRIVATE_'));
    // Untrusted Forwarded headers must not replace a direct socket address.
    const requestId = crypto.randomUUID();
    const response = await call('/api/trace-test',{sessionId:'owned',model:'gpt-6-luna',thinkingMode:true,reasoningProfile:'max'},
      {...bearer,'X-RAI-Client-Request-Id':requestId,'X-Forwarded-For':'203.0.113.99','X-RAI-Client-Context':Buffer.from(JSON.stringify(event.context)).toString('base64')});
    assert.equal(response.status,503);
    await tail;
    data = await (await call('/api/admin/user-activity?requestId='+requestId,null,headers)).json();
    assert.equal(data.events[0].metrics.status,503); assert.equal(data.events[0].context.selectedModel,'gpt-6-luna');
    assert.equal(data.events[0].context.reasoningProfile,'max'); assert.equal(data.events[0].network.clientIp,'127.0.0.1');
    assert.equal(data.events[0].serverRequestId,response.headers.get('X-RAI-Diagnostic-Id'));
    assert.equal((await (await call('/api/admin/user-activity?errorsOnly=true',null,headers)).json()).events.length,1);
    app.set('trust proxy','loopback');
    await call('/api/trace-test',{}, {...bearer,'X-Forwarded-For':'2001:db8::7'}); await tail;
    const ipv6 = JSON.parse((await get('SELECT details FROM user_activity ORDER BY row_id DESC LIMIT 1')).details).network;
    assert.equal(ipv6.clientIp,'2001:db8::7'); assert.equal(ipv6.clientIpVersion,6); assert.equal(ipv6.peerIp,'127.0.0.1');
    await run('UPDATE auth_sessions SET revoked_at=? WHERE session_id=?',[Math.floor(Date.now()/1000),session.sessionId]);
    assert.equal((await call('/api/user/activity',{events:[event]},bearer)).status,401,'revoked login cannot keep uploading');
    assert.equal(normalizeEvent({...event,context:null}).context.timezone,undefined);
    console.log('user-activity HTTP/SQLite PASS: real revocable auth, account binding, atomic batches, idempotency, millisecond timestamps, owned sessions, admin-only lookup, trace/model/effort correlation, direct IPv4 and trusted IPv6 provenance, payload exclusion');
  } finally { if (server) await new Promise(resolve => server.close(resolve)); await tail; await new Promise(resolve => db.close(resolve)); }

  let context = { token:'token-one', account:'one', apiBase:'/api', sessionId:'owned', environment:{timezone:'Asia/Shanghai',theme:'dark'} }, sent=[];
  const env = { fetch:async (_url,options) => {sent.push(options); return new Response('{}');}, location:{href:'https://rai.test/'}, crypto:crypto.webcrypto,
    setTimeout:()=>1, Request, Headers, btoa: value=>Buffer.from(value,'binary').toString('base64') };
  const client = createClient(env); client.configure(() => context);
  client.record('ui','SendButton'); await client.flush();
  assert.equal(JSON.parse(sent[0].body).events[0].context.timezone,'Asia/Shanghai');
  client.record('ui','PrivateOldAccount'); context={...context,token:'token-two',account:'two'}; client.record('ui','CurrentAccount'); await client.flush();
  assert.deepEqual(JSON.parse(sent[1].body).events.map(item=>item.action),['CurrentAccount']);
  assert.equal(sent[1].headers.Authorization,'Bearer token-two');
  const exact = new Response('unread'); let forwarded;
  const wrapped=client.wrapFetch(async(_url,options)=>{forwarded=options;return exact;});
  assert.equal(await wrapped('/api/chat/stream',{method:'POST',body:'PRIVATE_BODY'}),exact);
  assert.equal(exact.bodyUsed,false); assert.equal(forwarded.body,'PRIVATE_BODY');
  assert.equal(JSON.parse(Buffer.from(forwarded.headers.get('X-RAI-Client-Context'),'base64')).theme,'dark');
  const storage = new Map();
  env.localStorage = { getItem:key => storage.get(key), setItem:(key,value) => storage.set(key,value) };
  client.record('error','before_crash');
  const restarted = createClient(env); restarted.configure(() => context);
  await restarted.flush(); // Loads account-scoped pending events without replaying an action/request.
  assert.ok(JSON.parse(sent.at(-1).body).events.some(item => item.action === 'before_crash'));
  const brokenContext = createClient(env); brokenContext.configure(() => { throw new Error('optional_metadata_unavailable'); });
  assert.equal(await brokenContext.wrapFetch(async()=>exact)('/api/chat/stream'),exact,'environment failure cannot break a request');
  let release;
  const inFlight = client.wrapFetch(() => new Promise(resolve => { release=resolve; }))('/api/chat/stream');
  context={...context,token:'token-three',account:'three'};
  client.record('ui','NewAccountAction'); release(new Response('old account result')); await inFlight;
  client.diagnostic({ category:'stream',action:'error',activityOwner:'/api|two',sessionId:'owned' });
  await client.flush();
  assert.deepEqual(JSON.parse(sent.at(-1).body).events.map(item=>item.action),['NewAccountAction'],'in-flight old account HTTP and stream events must not attach to the next account');
  const latency = createChatLatencyTrace({}, { write(){} });
  const observed = await fetchWithLatency(async()=>new Response('data: {"type":"response.created","response":{"model":"gpt-6-luna-2026"}}\n\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n'), 'fixture',
    { body:JSON.stringify({model:'gpt-6-luna',reasoning:{effort:'none'}}) }, latency, { provider:'openai_official',model:'gpt-6-luna',streaming:true,call:1 });
  await observed.text();
  assert.equal(latency.activity().attempts[0].wireModel,'gpt-6-luna');
  assert.equal(latency.activity().attempts[0].reportedModel,'gpt-6-luna-2026');
  assert.equal(latency.activity().attempts[0].reasoningEffort,'none');
  assert.equal(latency.activity().attempts[0].provider,'openai_official');
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname,'../public/event-bindings.js'),'utf8');
  assert.ok(source.includes("record('ui', actionName")); assert.ok(!source.includes('record(\'ui\', element.value'));
  console.log('user-activity browser/provider PASS: environment/metadata headers, unchanged Response/body, account-isolated queue, crash recovery, optional metadata failure, actual wire/reported model and reasoning effort, trusted action names without handler arguments');
}
main().catch(error => { console.error(error); process.exitCode=1; });
