'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { once } = require('node:events');

async function main() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(source, /app\.set\('query parser', 'extended'\)/);
  // Complement the production-server suites with the changed framework boundaries.
  const app = express();
  app.set('query parser', 'extended');
  app.use(express.json({ limit: '1kb' }));
  app.use(express.urlencoded({ extended: true, limit: '1kb', parameterLimit: 8 }));
  app.get('/query', (req, res) => res.json(req.query));
  app.post('/body', (req, res) => res.json(req.body || {}));
  app.get('/failure', async () => { throw new Error('private-framework-error'); });
  app.use((error, req, res, next) => {
    res.status(error.status || 500).json({ code: error.status ? 'invalid_body' : 'internal_error' });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const query = await fetch(`${origin}/query?filter[name]=rai&ids[]=one&ids[]=two&__proto__[polluted]=yes&constructor[prototype][polluted]=yes`);
    const body = await query.json();
    assert.deepEqual(body.filter, { name: 'rai' });
    assert.deepEqual(body.ids, ['one', 'two']);
    assert.equal(body.polluted, undefined);
    assert.equal(Object.prototype.polluted, undefined);
    for (const [contentType, data, expectedStatus] of [
      ['application/json', '{"ok":true}', 200],
      ['application/json', '{broken', 400],
      ['application/json', JSON.stringify({ data: 'x'.repeat(2048) }), 413],
      ['application/x-www-form-urlencoded', 'filter[name]=rai', 200],
      ['application/x-www-form-urlencoded', Array.from({ length: 9 }, (_, index) => `a${index}=1`).join('&'), 413],
    ]) {
      const response = await fetch(`${origin}/body`, { method: 'POST', headers: { 'Content-Type': contentType }, body: data });
      assert.equal(response.status, expectedStatus);
      const result = await response.json();
      if (expectedStatus !== 200) assert.deepEqual(result, { code: 'invalid_body' });
      else if (contentType === 'application/json') assert.deepEqual(result, { ok: true });
      else assert.deepEqual(result, { filter: { name: 'rai' } });
    }
    const failure = await fetch(`${origin}/failure`);
    assert.equal(failure.status, 500);
    assert.deepEqual(await failure.json(), { code: 'internal_error' });
    assert.equal((await fetch(`${origin}/missing`)).status, 404);
    console.log('express5-regression ok: query compatibility, prototype isolation, JSON/form bounds, async errors and 404');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
