'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const schema = require('../public/interactive-visual-schema');
const visuals = require('../public/interactive-visuals');
const { buildInteractiveVisualPrompt, appendInteractiveVisualState } = require('../lib/interactive-visual-prompt');
const root = path.resolve(__dirname, '..');
const budget = { type: 'budget', title: 'Travel plan', unit: 'CNY', budget: 1000,
  items: [{ label: 'Transport', value: 350.25 }, { label: 'Stay', value: 500.5 }] };
const comparison = { type: 'comparison', title: 'Return change', unit: '%',
  items: [{ label: 'A', value: -3.5 }, { label: 'B', value: 0 }, { label: 'C', value: 7.25 }] };
const checklist = { type: 'checklist', title: 'Preparation',
  items: [{ label: 'Confirm dates', checked: false }, { label: 'Tickets', checked: true }, { label: 'Packing', checked: false }] };
const copy = value => JSON.parse(JSON.stringify(value));
const fence = value => '```rai_visual\n' + JSON.stringify(value) + '\n```';

function schemaCases() {
  for (const spec of [budget, comparison, checklist]) {
    const original = copy(spec), parsed = schema.validate(original);
    assert.deepEqual(parsed, spec);
    assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.items) && Object.isFrozen(parsed.items[0]));
    original.items[0].label = 'Changed outside the card';
    assert.equal(parsed.items[0].label, spec.items[0].label, 'validation takes an immutable, independent snapshot');
    assert.deepEqual(schema.parse(JSON.stringify(spec)), spec);
  }
  const invalid = [
    null, [], 'budget', {}, { ...budget, type: '__proto__' }, { ...budget, type: 'html' },
    { ...budget, html: '<script>alert(1)</script>' }, { ...budget, onApply: 'fetch("/")' },
    { ...budget, items: [{ label: 'x', value: 1, onclick: 'alert(1)' }] },
    { ...budget, title: '' }, { ...budget, title: ' '.repeat(10) }, { ...budget, title: 'x'.repeat(121) },
    { ...budget, title: 'a\nb' }, { ...budget, title: 'a\u202eb' },
    { ...budget, unit: '' }, { ...budget, unit: 'x'.repeat(17) },
    { ...budget, items: [] }, { ...budget, items: Array(25).fill({ label: 'x', value: 1 }) },
    { ...budget, items: [{ label: 'x'.repeat(121), value: 1 }] },
    { ...budget, items: [{ label: 'x', value: '1' }] },
    { ...checklist, unit: 'count' }, { ...checklist, items: [{ label: 'x', checked: 'false' }] },
    { ...comparison, items: [{ label: 'x', value: 0.0000001 }] },
    JSON.parse(JSON.stringify(budget).replace('"type":', '"__proto__":{},"type":')),
    { ...budget, constructor: {} }, { ...budget, prototype: {} }, { ...budget, [Symbol('extra')]: true }
  ];
  for (const value of [NaN, Infinity, -Infinity, -1, 1000000000.01, 0.001, null, '0']) {
    invalid.push({ ...budget, budget: value }, { ...budget, items: [{ label: 'x', value }] });
    assert.equal(schema.isBudgetAmount(value), false);
    assert.equal(schema.calculateBudget(value, [1]), null);
  }
  const cyclic = copy(budget);
  cyclic.items[0].value = cyclic;
  invalid.push(cyclic);
  const inherited = Object.assign(Object.create({ unexpected: true }), budget);
  invalid.push(inherited);
  const sparse = Array(2);
  sparse[1] = budget.items[0];
  invalid.push({ ...budget, items: sparse });
  let getterCalls = 0;
  const getter = { ...budget };
  Object.defineProperty(getter, 'budget', { enumerable: true, get() { getterCalls += 1; throw new Error('must not execute'); } });
  invalid.push(getter);
  const getterArray = [budget.items[0]];
  Object.defineProperty(getterArray, '0', { get() { getterCalls += 1; throw new Error('must not execute'); } });
  invalid.push({ ...budget, items: getterArray });
  for (const spec of invalid) assert.equal(schema.validate(spec), null, 'reject malformed/hostile schema');
  assert.equal(getterCalls, 0, 'validation must not call getters');

  assert.ok(schema.validate({ ...budget, title: 'x'.repeat(120), unit: 'x'.repeat(16),
    items: Array.from({ length: 24 }, () => ({ label: 'x'.repeat(120), value: 1000000000 })) }));
  assert.ok(schema.validate({ ...comparison, items: [{ label: 'Low', value: -1000000000 }, { label: 'High', value: 1000000000 }, { label: 'Tiny', value: 0.000001 }] }));
  assert.ok(schema.validate({ ...budget, budget: 0, items: [{ label: '<img src=x onerror=alert(1)>', value: 0 }] }),
    'markup-like labels are plain text, not executable fields');
  for (const raw of ['', 'null', '{', 'NaN', 'Infinity', '{"type":"budget","budget":1e999}', '(() => alert(1))()',
    ' '.repeat(schema.limits.maxBlockLength + 1), '['.repeat(5000) + '0' + ']'.repeat(5000)]) {
    assert.equal(schema.parse(raw), null);
  }
  assert.deepEqual(schema.calculateBudget(0.3, [0.1, 0.2]), { total: 0.3, remaining: 0, overspend: 0 });
  assert.deepEqual(schema.calculateBudget(0.3, [0.1, 0.23]), { total: 0.33, remaining: -0.03, overspend: 0.03 });
  assert.deepEqual(schema.calculateBudget(0, [0]), { total: 0, remaining: 0, overspend: 0 });
  assert.deepEqual(schema.calculateBudget(1000000000, Array(24).fill(1000000000)),
    { total: 24000000000, remaining: -23000000000, overspend: 23000000000 });
  assert.equal(schema.calculateBudget(100, [-1]), null);
  assert.equal(schema.calculateBudget(100, []), null);
  console.log(`interactive-visuals: schema boundaries, ${invalid.length} invalid objects, no accessors/recursion, immutable originals and exact budget arithmetic passed`);
}

function parserAndPromptCases() {
  const raw = fence(budget);
  const mixed = 'Before\n' + raw + '\nAfter\n' + fence(comparison);
  assert.deepEqual(visuals.parseBlocks(mixed), [{ spec: budget, raw }, { spec: comparison, raw: fence(comparison) }]);
  assert.equal(visuals.stripBlocks(mixed), 'Before\n\nAfter\n');
  for (let end = 0; end < raw.length; end += 1) {
    assert.equal(visuals.parseBlocks(raw.slice(0, end)).length, 0, 'a streaming partial block stays text');
    assert.equal(visuals.stripBlocks(raw.slice(0, end)), raw.slice(0, end));
  }
  const invalid = '```rai_visual\n{"type":"html","html":"<script>alert(1)</script>"}\n```';
  const partial = '```rai_visual\n{"type":"budget"';
  assert.equal(visuals.stripBlocks(raw + '\n' + invalid + '\n' + partial), '\n' + invalid + '\n' + partial);
  assert.equal(visuals.parseBlocks(raw + '\n' + partial).length, 1);
  const incompleteFence = '```rai_visual\n' + JSON.stringify(checklist) + '\n``';
  assert.equal(visuals.stripBlocks(raw + '\n' + incompleteFence), '\n' + incompleteFence,
    'even complete JSON stays text until its streaming fence has closed');
  const mermaid = '```mermaid\ngraph TD; A-->B\n```';
  assert.equal(visuals.stripBlocks(mermaid + '\n' + raw), mermaid + '\n', 'Mermaid is unaffected');
  const oversized = '```rai_visual\n' + ' '.repeat(schema.limits.maxBlockLength) + JSON.stringify(budget) + '\n```';
  assert.equal(visuals.stripBlocks(oversized), oversized, 'over-limit JSON stays visible as original text');
  for (const wrapped of ['````markdown\n' + raw + '\n````', '~~~text\n' + raw + '\n~~~',
    '```js\n' + raw + '\n```', raw.replace(/^/gm, '    '), 'prefix ' + raw, raw.replace('rai_visual', 'rai_visual extra')]) {
    assert.equal(visuals.parseBlocks(wrapped).length, 0, 'examples inside other code/inline text must not become controls');
    assert.equal(visuals.stripBlocks(wrapped), wrapped);
  }
  const crlf = raw.replace(/\n/g, '\r\n');
  assert.equal(visuals.parseBlocks(crlf)[0].raw, crlf);
  assert.equal(visuals.stripBlocks('Before\r\n' + crlf + '\r\nAfter'), 'Before\r\n\r\nAfter');
  assert.equal(visuals.parseBlocks('  ' + raw.replace(/\n```$/, '\n  ```')).length, 1);
  const tooMany = Array(9).fill(raw).join('\n');
  assert.equal(visuals.parseBlocks(tooMany).length, schema.limits.maxBlocks);
  assert.ok(visuals.stripBlocks(tooMany).endsWith(raw), 'over-limit blocks remain available as text');
  const tooLong = 'x'.repeat(schema.limits.maxContentLength) + '\n' + raw;
  assert.equal(visuals.stripBlocks(tooLong), tooLong);
  assert.deepEqual(visuals.parseBlocks(null), []);
  const context = vm.createContext({ window: {} });
  for (const file of ['interactive-visual-schema.js', 'interactive-controls.js', 'interactive-visuals.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, 'public', file), 'utf8'), context);
  }
  assert.equal(context.window.RAIInteractiveVisualSchema.parse(JSON.stringify(budget)).budget, budget.budget);
  assert.equal(context.window.RAIInteractiveVisuals.parseBlocks(raw)[0].raw, raw);
  const form = { type: 'form', id: 'preferences', title: 'Preferences', submitLabel: 'Use', controls: [
    { kind: 'slider', id: 'amount', label: 'Amount', min: 0, max: 100, step: 5, value: 50, unit: '%' }
  ] };
  assert.ok(schema.validate(form));
  const invalidForms = [
    { ...form, id: '../bad' }, { ...form, action: '/submit' }, { ...form, controls: [] },
    { ...form, controls: Array(17).fill(form.controls[0]) },
    { ...form, controls: [form.controls[0], form.controls[0]] },
    { ...form, controls: [{ ...form.controls[0], value: 52 }] },
    { ...form, controls: [{ ...form.controls[0], step: 0 }] },
    { ...form, controls: [{ ...form.controls[0], max: 0 }] },
    { ...form, controls: [{ ...form.controls[0], onChange: 'execute()' }] },
    { ...form, controls: [{ kind: 'date', id: 'day', label: 'Day', value: '2026-02-30' }] },
    { ...form, controls: [{ kind: 'input', id: 'name', label: 'Name', value: 'x'.repeat(1201), placeholder: '', required: false }] },
    { ...form, controls: [{ kind: 'select', id: 'choice', label: 'Choice', options: [{ label: 'A', value: 'same' }, { label: 'B', value: 'same' }], value: 'same' }] }
  ];
  for (const value of invalidForms) assert.equal(schema.validate(value), null, 'reject executable, ambiguous, unbounded and invalid-calendar controls');
  let stateGetterCalls = 0;
  const accessorState = [form];
  Object.defineProperty(accessorState, '0', { get() { stateGetterCalls += 1; return form; } });
  assert.equal(schema.validateState(accessorState), null);
  assert.equal(stateGetterCalls, 0);
  for (const language of ['zh-CN', 'en-US']) {
    const prompt = buildInteractiveVisualPrompt(language);
    assert.ok(prompt.length < 5000, 'bounded component protocol and examples');
    assert.deepEqual(visuals.parseBlocks(prompt).map(block => block.spec.type), ['budget', 'comparison', 'checklist', 'form']);
    assert.ok(prompt.includes('Mermaid') && prompt.includes(String(schema.limits.maxValue)));
    assert.match(prompt, language === 'en-US' ? /user or verified results/ : /用户或已核实结果/);
    assert.match(prompt, language === 'en-US' ? /do not force visuals into every answer/ : /不要每个回答都强行可视化/);
  }
  const updated = { ...budget, id: 'travel', budget: 1500 };
  const messages = [
    { role: 'assistant', id: 1, content: fence({ ...budget, id: 'travel' }) },
    { role: 'user', content: fence(checklist) },
    { role: 'assistant', id: 3, content: fence(updated) + '\n' + fence({ ...checklist, id: 'todo' }) }
  ];
  assert.deepEqual(visuals.collectLatest(messages), [{ spec: updated, sourceId: 3, sourceKey: 3 }, { spec: { ...checklist, id: 'todo' }, sourceId: 3, sourceKey: 3 }]);
  assert.deepEqual(visuals.collectLatest([...messages, { role: 'assistant', content: fence({ type: 'remove', id: 'travel' }) }]),
    [{ spec: { ...checklist, id: 'todo' }, sourceId: 3, sourceKey: 3 }], 'same-id updates and removals keep only relevant cards');
  assert.deepEqual(visuals.segments('Before\n' + raw + '\nAfter').map(part => part.spec ? part.spec.type : part.text), ['Before\n', 'budget', '\nAfter']);
  const payload = [{ role: 'system', content: 'System' }, { role: 'user', content: 'Continue' }];
  const attached = appendInteractiveVisualState(payload, [updated]);
  assert.deepEqual(attached[0], payload[0]);
  assert.match(attached[1].content, /untrusted user data/);
  assert.ok(attached[1].content.includes('1500'));
  assert.equal(payload[1].content, 'Continue');
  assert.equal(appendInteractiveVisualState(payload, [{ ...budget, html: 'bad' }]), payload);
  assert.equal(schema.validateState(Array(9).fill(budget)), null);
  console.log('interactive-visuals: fenced-block parsing, streaming partials, invalid-text retention, bounds, UMD and bilingual prompt examples passed');
}

async function browserCases() {
  const { chromium, webkit } = require('playwright');
  const engine = process.env.RAI_BROWSER_ENGINE === 'webkit' ? webkit : chromium;
  const executablePath = process.env.RAI_QR_BROWSER_EXECUTABLE;
  const browser = await engine.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  try {
    for (const [width, language] of [[1280, 'en-US'], [390, 'zh-CN']]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 500, serviceWorkers: 'block' });
      const english = language === 'en-US';
      try {
        const page = await context.newPage(), requests = [], errors = [];
        page.on('request', request => requests.push(request.url()));
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/*', route => route.abort());
        await page.setContent('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main class="message-content" id="fixture"><div id="host"></div><p id="neighbor">Existing message</p><div id="second"></div></main></body></html>');
        await page.addStyleTag({ path: path.join(root, 'public/styles.css') });
        await page.addStyleTag({ path: path.join(root, 'public/interactive-visuals.css') });
        await page.addStyleTag({ content: 'html,body{height:auto;overflow:auto}#fixture{width:100%;max-width:760px;margin:0 auto;padding:16px}#fixture .rai-visual{box-sizing:border-box}' });
        await page.addScriptTag({ path: path.join(root, 'public/interactive-visual-schema.js') });
        await page.addScriptTag({ path: path.join(root, 'public/interactive-controls.js') });
        await page.addScriptTag({ path: path.join(root, 'public/interactive-visuals.js') });
        await page.evaluate(({ spec, language }) => {
          window.sourceSpec = spec;
          window.drafts = [];
          window.card = RAIInteractiveVisuals.mount(document.getElementById('host'), spec, { language, onApply: text => drafts.push(text) });
          window.firstInput = document.querySelector('.rai-visual-number');
        }, { spec: budget, language });
        const field = name => page.locator('.rai-visual-number[data-field="' + name + '"]');
        const apply = page.locator('[data-action="apply"]'), reset = page.locator('[data-action="reset"]');
        const metrics = () => page.locator('.rai-visual-metric').allTextContents();
        assert.equal(await page.locator('.rai-visual-kind').textContent(), english ? 'Budget scenario' : '预算试算');
        assert.equal(await apply.textContent(), english ? 'Use in follow-up' : '确认用于后续');
        assert.equal(await reset.textContent(), english ? 'Reset to original' : '还原初始数据');
        assert.match(await page.locator('.rai-visual-note').textContent(), english ? /not verified quotes/ : /不代表真实报价/);
        assert.match(await page.locator('.rai-visual-status').textContent(), english ? /never sent automatically/ : /不会自动发送/);
        assert.deepEqual(await metrics(), ['850.75 CNY', '149.25 CNY']);
        await field('item-0').fill('650.50');
        await field('budget').fill('1000.01');
        const range = page.locator('.rai-visual-range[data-field="item-0"]');
        await range.focus();
        await range.press('ArrowRight');
        assert.equal(await field('item-0').inputValue(), '650.51');
        assert.deepEqual(await metrics(), ['1,151.01 CNY', '151 CNY']);
        assert.equal(await page.locator('.rai-visual').getAttribute('data-state'), 'dirty');
        assert.match(await page.locator('.rai-visual-status').textContent(), english ? /Modified.*not yet used/ : /已修改.*未用于后续/);
        assert.ok((await page.locator('.rai-visual-original').allTextContents()).some(text => text.includes('350.25 CNY')));
        assert.deepEqual(await page.evaluate(() => sourceSpec), budget, 'local interaction must not overwrite model data');
        await page.evaluate(() => {
          document.getElementById('neighbor').textContent += ' — later text';
          document.getElementById('second').appendChild(card.element);
        });
        assert.equal(await page.evaluate(() => firstInput === document.querySelector('.rai-visual-number')), true, 'updates and reparenting preserve input identity');
        assert.equal(await field('item-0').inputValue(), '650.51');
        assert.equal(await page.evaluate(() => drafts.length), 0, 'dragging and input never call the host');
        await apply.click();
        const draft = await page.evaluate(() => drafts[0]);
        assert.ok(draft.includes('"Travel plan"') && draft.includes('"Transport": 350.25 CNY → 650.51 CNY'));
        assert.ok(draft.includes('1,000 CNY → 1,000.01 CNY') && draft.includes('"Stay": 500.5 CNY'));
        assert.equal(await page.locator('.rai-visual').getAttribute('data-state'), 'draft');
        assert.match(await page.locator('.rai-visual-status').textContent(), english ? /Draft filled.*not sent/ : /已填写草稿.*尚未发送/);
        await reset.click();
        assert.equal(await field('budget').inputValue(), '1000');
        assert.equal(await field('item-0').inputValue(), '350.25');
        assert.deepEqual(await metrics(), ['850.75 CNY', '149.25 CNY']);
        assert.equal(await page.locator('.rai-visual').getAttribute('data-state'), 'dirty', 'reset after applying is a new, unadopted local state');
        assert.equal(await page.evaluate(() => drafts.length), 1, 'reset never silently rewrites a draft');
        for (const invalid of ['', '-1', '0.001', '1000000000.01']) {
          await field('item-0').fill(invalid);
          assert.equal(await apply.isDisabled(), true);
          assert.equal(await page.locator('.rai-visual-error').isVisible(), true);
          assert.match(await page.locator('.rai-visual-error').textContent(), english ? /last valid value/ : /上次有效值/);
          assert.deepEqual(await metrics(), ['850.75 CNY', '149.25 CNY'], 'invalid input retains the last valid total with explicit feedback');
          await reset.click();
        }
        await field('item-0').fill('1000000000');
        assert.equal(await range.getAttribute('max'), '1000000000', 'numeric entry expands the slider within the schema cap');
        assert.equal(await apply.isDisabled(), false);
        await reset.click();
        await field('budget').fill('0');
        assert.equal(await page.locator('.rai-visual-meter').getAttribute('aria-valuenow'), '100');
        await reset.click();
        const dark = await page.locator('.rai-visual').evaluate(node => getComputedStyle(node).backgroundColor);
        await page.evaluate(() => document.documentElement.dataset.theme = 'light');
        const light = await page.locator('.rai-visual').evaluate(node => getComputedStyle(node).backgroundColor);
        assert.notEqual(light, dark, 'the card follows the existing theme variables');
        assert.equal(await page.locator('.rai-visual').evaluate(node => getComputedStyle(node).borderTopWidth), '0px');
        await page.setViewportSize({ width: 320, height: 900 });
        const bounds = await page.locator('.rai-visual').evaluate(node => ({
          left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right,
          overflow: node.scrollWidth - node.clientWidth
        }));
        assert.ok(bounds.left >= 0 && bounds.right <= 320 && bounds.overflow <= 1, JSON.stringify(bounds));
        await page.evaluate(() => {
          const staleButton = card.element.querySelector('[data-action="apply"]');
          card.destroy();
          staleButton.click();
        });
        assert.equal(await page.evaluate(() => drafts.length), 1, 'destroy removes handlers even on retained detached nodes');
        assert.equal(await page.locator('.rai-visual').count(), 0);
        assert.ok((await page.locator('#neighbor').textContent()).startsWith('Existing message'), 'destroy preserves neighboring message content');

        await page.evaluate(({ spec, language }) => {
          window.card = RAIInteractiveVisuals.mount(document.getElementById('host'), spec, { language, onApply: text => drafts.push(text) });
        }, { spec: checklist, language });
        assert.equal(await page.locator('.rai-visual-kind').textContent(), english ? 'Checklist' : '交互清单');
        assert.match(await page.locator('.rai-visual-note').textContent(), english ? /not verified completion/ : /不代表已核实完成/);
        assert.equal(await page.locator('.rai-visual-meter').getAttribute('aria-valuenow'), '1');
        await page.getByRole('checkbox', { name: 'Confirm dates', exact: true }).check();
        assert.equal(await page.locator('.rai-visual-meter').getAttribute('aria-valuenow'), '2');
        assert.equal(await page.evaluate(() => drafts.length), 1);
        await apply.click();
        const checkDraft = await page.evaluate(() => drafts.at(-1));
        assert.ok(checkDraft.includes('"Preparation"') && checkDraft.includes('2/3'));
        assert.match(checkDraft, language === 'en-US' ? /"Confirm dates": unchecked → checked/ : /"Confirm dates": 未勾选 → 已勾选/);
        await reset.click();
        assert.equal(await page.getByRole('checkbox', { name: 'Confirm dates', exact: true }).isChecked(), false);
        await page.evaluate(() => card.destroy());

        await page.evaluate(({ spec, language }) => {
          window.card = RAIInteractiveVisuals.mount(document.getElementById('host'), spec, { language, onApply: text => drafts.push(text) });
        }, { spec: comparison, language });
        assert.equal(await page.locator('.rai-visual-kind').textContent(), english ? 'Same-metric comparison' : '同一度量对比');
        assert.match(await page.locator('.rai-visual-note').textContent(), english ? /not added together/ : /互不相加/);
        assert.equal(await page.locator('.rai-visual-summary').count(), 0, 'independent comparison alternatives are never totalled');
        const bars = await page.locator('.rai-visual-track .rai-visual-bar').evaluateAll(nodes => nodes.map(node => ({ left: parseFloat(node.style.left), width: parseFloat(node.style.width) })));
        assert.equal(bars[0].left, 0);
        assert.equal(bars[1].width, 0);
        assert.ok(Math.abs(bars[0].width + bars[2].width - 100) < 0.0001, 'signed bars share one zero baseline and scale');
        await page.locator('[data-action="inspect"][data-index="2"]').click();
        assert.equal(await page.evaluate(() => drafts.length), 3);
        const comparisonDraft = await page.evaluate(() => drafts.at(-1));
        assert.ok(comparisonDraft.includes('"Return change"') && comparisonDraft.includes('"C" (7.25 %)') && comparisonDraft.includes('"A": -3.5 %'));
        assert.equal(await page.locator('[data-index="2"]').getAttribute('aria-pressed'), 'true');
        await page.evaluate(() => card.destroy());

        const hostile = { ...budget, title: '<svg onload="window.visualExecuted=1">', items: [{ label: '<img src=x onerror="window.visualExecuted=1">', value: 1 }] };
        await page.evaluate(({ spec, language }) => {
          window.visualExecuted = 0;
          window.card = RAIInteractiveVisuals.mount(document.getElementById('host'), spec, { language });
        }, { spec: hostile, language });
        assert.equal(await page.locator('.rai-visual-title').textContent(), hostile.title);
        assert.equal(await page.locator('.rai-visual script,.rai-visual img,.rai-visual svg,.rai-visual iframe').count(), 0);
        assert.equal(await page.evaluate(() => visualExecuted), 0);
        assert.equal(await apply.isDisabled(), true, 'a missing host callback cannot claim to have applied data');
        assert.match(await page.locator('.rai-visual-status').textContent(), english ? /has not connected/ : /尚未连接/);
        await page.evaluate(language => {
          card.destroy();
          window.card = RAIInteractiveVisuals.mount(document.getElementById('host'), { type: 'html', html: '<img src=x>' }, { language });
        }, language);
        assert.equal(await page.locator('#host [role="alert"]').count(), 1);
        assert.match(await page.locator('#host [role="alert"]').textContent(), english ? /could not be parsed/ : /无法解析/);
        assert.equal(await page.locator('#host img').count(), 0);
        await page.evaluate(() => card.destroy());
        await page.evaluate(({ spec, language }) => {
          window.card = RAIInteractiveVisuals.mount(document.getElementById('host'), spec, { language, onApply() { throw new Error('host rejected the draft'); } });
        }, { spec: budget, language });
        await field('budget').fill('1200');
        await apply.click();
        assert.equal(await page.locator('.rai-visual-error').isVisible(), true);
        assert.match(await page.locator('.rai-visual-error').textContent(), english ? /could not be filled/ : /未能填写草稿/);
        assert.equal(await page.locator('.rai-visual').getAttribute('data-state'), 'dirty');
        assert.equal(await page.evaluate(() => drafts.length), 3);
        assert.deepEqual(requests, [], 'rendering and interaction must not make any network requests');
        assert.deepEqual(errors, []);
        console.log(`interactive-visuals: ${engine.name()} ${width}px ${language} + 320px layout, localized UI/status/errors, budget edits/reset, checklist, signed comparison, draft-only callbacks, lifecycle, themes and DOM injection passed`);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
}

(async () => {
  schemaCases();
  parserAndPromptCases();
  if (process.argv.includes('--browser')) await browserCases();
})().catch(error => { console.error(error); process.exitCode = 1; });
