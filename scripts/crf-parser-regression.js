'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const parsers = [require('../lib/crf-signature'), require('../crf-signature')];

for (const parser of parsers) {
  const title = parser.parseCrfTitle || parser.parseTitle;
  const source = parser.parseCrfSource || parser.parseSource;
  const model = parser.parseCrfModel || parser.parseModel;
  assert.equal(title('<!-- title: 出行预算 -->'), '出行预算');
  assert.equal(title('<!-- title:bad\nvalue--><!-- title:good -->'), 'good');
  assert.equal(title('<!-- title: -->'), '');
  assert.equal(title('<!--title:-->'), '导入对话');
  assert.equal(source('<!--source:https://example.test/a-->'), 'https://example.test/a');
  assert.equal(source('unsigned text'), null);
  assert.equal(model('unsigned text'), 'auto');
  assert.deepEqual(parser.parseCrfMessages('<!--message:user-->\r\n## 用户\r\n\r\n问题<!--end message-->'
    + '<!--message:assistant-->## AI 回复\n\n答案<!--end message-->'), [
    { role: 'user', content: '问题' }, { role: 'assistant', content: '答案' }
  ]);
  assert.deepEqual(parser.parseCrfMessages('<!--message:user-->outer<!--message:assistant-->inner<!--end message-->'), [
    { role: 'user', content: 'outer<!--message:assistant-->inner' }
  ]);
  assert.deepEqual(parser.parseCrfMessages('<!--message:user-->unfinished'), []);
}

// A separate process bounds the regression even if a parser starts backtracking.
const child = spawnSync(process.execPath, ['-e', `
  const p = require('./lib/crf-signature');
  p.parseCrfTitle('<!--title:' + '\\t'.repeat(1000000));
  p.parseCrfTitle('<!--title:x\\n'.repeat(100000) + '-->');
  p.parseCrfMessages('<!--message:user-->a'.repeat(100000));
`], { cwd: require('node:path').resolve(__dirname, '..'), timeout: 5000, encoding: 'utf8' });
assert.ifError(child.error);
assert.equal(child.status, 0, child.stderr);
console.log('CRF parser: metadata, nested messages, legacy exports and large malformed inputs passed');
