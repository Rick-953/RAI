'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, webkit } = require('playwright');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
}
const definitions = section('const RAI_SANITIZE_CONFIG =', 'function sanitizeReasoningText')
  + section('function escapeHtml(text)', 'function loadSettings()')
  + section('function normalizeSafeLinkUrl(', 'function normalizeSafeImageUrl(')
  + section('function renderCitations(', 'function renderSourcesList(')
  + section('function getSourceKind(', 'function groupSourcesForDisplay(');
const streaming = section('    function renderStreamingContent()', '    function hydrateStreamingMermaidCache()');
assert.ok(streaming.indexOf('html = sanitizeRenderedHtml(html);') > streaming.indexOf('html = renderCitations('));
assert.ok(streaming.indexOf('html = sanitizeRenderedHtml(html);') < streaming.indexOf('const renderSignature ='));

(async () => {
  const engine = process.env.RAI_BROWSER_ENGINE === 'webkit' ? webkit : chromium;
  const browser = await engine.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="target"></div>');
    await page.addScriptTag({ path: path.join(root, 'public/lib/purify.min.js') });
    await page.addScriptTag({ path: path.join(root, 'public/lib/marked.min.js') });
    await page.addScriptTag({ content: definitions });
    const result = await page.evaluate(() => {
      window.__citationExecuted = 0;
      const markdown = '![x](/missing.png "[1]")';
      const html = sanitizeRenderedHtml(marked.parse(markdown));
      const cited = renderCitations(html, [{ url: '# onerror=window.__citationExecuted++ x=', title: 'test', marker: '1' }]);
      const target = document.getElementById('target');
      target.innerHTML = sanitizeRenderedHtml(cited);
      target.querySelectorAll('img').forEach(image => image.dispatchEvent(new Event('error')));
      return {
        executed: window.__citationExecuted,
        unsafe: target.querySelectorAll('[onerror], script, svg, iframe').length,
        text: target.textContent
      };
    });
    assert.equal(result.executed, 0);
    assert.equal(result.unsafe, 0);
    console.log(`Markdown citation security: ${engine.name()} passed without relying on CSP`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
