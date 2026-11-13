'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const { chromium, webkit } = require('playwright');
const spec = {
  "type": "form",
  "id": "travel-plan",
  "title": "Travel preferences",
  "submitLabel": "Use these preferences",
  "controls": [
    {
      "kind": "button",
      "id": "review",
      "label": "Review choices"
    },
    {
      "kind": "checkbox",
      "id": "direct",
      "label": "Direct route",
      "checked": false
    },
    {
      "kind": "radio",
      "id": "travel",
      "label": "Travel mode",
      "options": [
        {
          "label": "Train",
          "value": "train"
        },
        {
          "label": "Bus",
          "value": "bus"
        }
      ],
      "value": "train"
    },
    {
      "kind": "segmented",
      "id": "pace",
      "label": "Travel pace",
      "options": [
        {
          "label": "Slow",
          "value": "slow"
        },
        {
          "label": "Fast",
          "value": "fast"
        }
      ],
      "value": "slow"
    },
    {
      "kind": "select",
      "id": "seat",
      "label": "Seat",
      "options": [
        {
          "label": "Window",
          "value": "window"
        },
        {
          "label": "Aisle",
          "value": "aisle"
        }
      ],
      "value": "window"
    },
    {
      "kind": "slider",
      "id": "hours",
      "label": "Duration",
      "min": 0,
      "max": 10,
      "step": 0.1,
      "value": 2.5,
      "unit": "hours"
    },
    {
      "kind": "input",
      "id": "name",
      "label": "Name",
      "value": "",
      "placeholder": "Enter a name",
      "required": true
    },
    {
      "kind": "textarea",
      "id": "notes",
      "label": "Notes",
      "value": "No restrictions",
      "placeholder": "Optional details",
      "required": false
    },
    {
      "kind": "date",
      "id": "departure",
      "label": "Departure date",
      "value": ""
    },
    {
      "kind": "popover",
      "id": "help",
      "label": "More information",
      "text": "These preferences are a local draft."
    },
    {
      "kind": "carousel",
      "id": "routes",
      "label": "Route previews",
      "items": [
        {
          "title": "North",
          "text": "Scenic route"
        },
        {
          "title": "South",
          "text": "Direct route"
        }
      ]
    },
    {
      "kind": "pressable",
      "id": "flexible",
      "label": "Flexible dates",
      "text": "Allow nearby dates",
      "selected": false
    },
    {
      "kind": "badge",
      "id": "estimate",
      "label": "Estimate",
      "text": "This is a planning estimate, not a verified quote."
    }
  ]
};
const schemaPath = path.join(root, 'public/interactive-visual-schema.js');
const schema = require(schemaPath);
assert(schema.validate(spec), 'the actual host schema must accept the complete fixture');
assert.deepEqual(Object.keys(require('../public/interactive-controls.js')), ['mount'], 'Node UMD export');
const engine = process.env.RAI_BROWSER_ENGINE === 'webkit' ? webkit : chromium;
const results = [];
const copy = value => JSON.parse(JSON.stringify(value));

async function run() {
  const engineName = engine.name();
  const browser = await engine.launch({ headless: true, ...(process.env.RAI_QR_BROWSER_EXECUTABLE ? { executablePath: process.env.RAI_QR_BROWSER_EXECUTABLE } : {}) });
  try {
    for (const [width, language] of [[1280, 'en-US'], [390, 'zh-CN']]) {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, hasTouch: width < 500, serviceWorkers: 'block' });
      const page = await context.newPage();
      const pageErrors = [], requests = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      page.on('request', request => requests.push(request.url()));
      await page.route('**/*', route => route.abort());
      await page.setContent('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main id="host"></main><p id="neighbor">Neighbor</p><button id="outside">Outside</button></body></html>');
      await page.addStyleTag({ path: path.join(root, 'public/styles.css') });
      await page.addStyleTag({ path: path.join(root, 'public/interactive-visuals.css') });
      // Restore a scrollable fixture document; do not override control layout or sizing.
      await page.addStyleTag({ content: 'html,body{height:auto;overflow:auto}body{margin:0}#host{width:100%;max-width:800px;margin:0 auto;min-width:0}#outside{display:block}' });
      await page.addScriptTag({ path: schemaPath });
      await page.addScriptTag({ path: path.join(root, 'public/interactive-controls.js') });
      async function mount(nextSpec = spec, current) {
        await page.evaluate(({ nextSpec, current, language }) => {
          window.card?.destroy();
          window.drafts = [];
          window.changes = [];
          window.source = nextSpec;
          window.card = RAIInteractiveControls.mount(document.getElementById('host'), nextSpec, {
            language, current,
            onChange(value) { changes.push(value); },
            onApply(text) { drafts.push(text); }
          });
        }, { nextSpec, current, language });
      }
      const field = id => page.locator('.rai-control[data-control-id="' + id + '"]');
      const state = () => page.evaluate(() => card.getSpec());
      const changeCount = () => page.evaluate(() => changes.length);
      const draftCount = () => page.evaluate(() => drafts.length);
      await mount();
      assert.equal(await page.locator('form').count(), 1);
      assert.equal(await page.locator('.rai-control').count(), 13);
      assert.equal(await changeCount(), 0, 'mount does not report fake changes');
      assert.equal(await draftCount(), 0);
      assert.equal(await field('travel').getByRole('group', { name: 'Travel mode' }).count(), 1);
      assert.equal(await field('pace').locator('input[type=radio]').count(), 2);
      assert.equal(await field('departure').locator('input').getAttribute('type'), 'date');

      await page.locator('button[type=submit]').click();
      assert.equal(await draftCount(), 0, 'required validation blocks draft');
      assert.equal(await field('name').locator('input').getAttribute('aria-invalid'), 'true');
      assert.equal(await field('name').locator('input').evaluate(node => node === document.activeElement), true);
      await field('name').locator('input').fill('  ');
      await page.locator('button[type=submit]').click();
      assert.equal(await draftCount(), 0, 'whitespace-only required field is invalid');
      await field('name').locator('input').fill('Lin');

      let before = await changeCount();
      await field('direct').locator('input').check();
      assert.equal(await changeCount(), before + 1, 'input + change emit one meaningful snapshot');
      await field('travel').getByRole('radio', { name: 'Bus', exact: true }).check();
      await field('pace').locator('.rai-control-option').filter({ hasText: 'Fast' }).click();
      assert.equal(await field('pace').getByRole('radio', { name: 'Fast', exact: true }).isChecked(), true);
      await field('seat').locator('select').selectOption('aisle');
      await field('notes').locator('textarea').fill('Line one\nLine two');
      await field('departure').locator('input').fill('2028-02-29');
      await field('flexible').getByRole('button').click();
      assert.equal(await field('flexible').getByRole('button').getAttribute('aria-pressed'), 'true');
      assert.equal(await draftCount(), 0, 'editing, selecting and toggling never apply a draft');

      const numeric = field('hours').locator('input[type=number]');
      const range = field('hours').locator('input[type=range]');
      await numeric.fill('3.7');
      assert.equal(await range.inputValue(), '3.7');
      for (const invalid of ['', '-1', '11', '0.15']) {
        before = await changeCount();
        await numeric.fill(invalid);
        assert.equal(await numeric.getAttribute('aria-invalid'), 'true');
        assert.equal((await state()).controls.find(c => c.id === 'hours').value, 3.7);
        assert.equal(await changeCount(), before, 'invalid numeric values never enter state');
        await page.locator('button[type=submit]').click();
        assert.equal(await draftCount(), 0);
      }
      await range.focus();
      await range.press('ArrowRight');
      assert.equal(await numeric.inputValue(), '3.8', 'range repairs an invalid precise input');
      assert.equal(await numeric.getAttribute('aria-invalid'), 'false');
      await numeric.fill('0.3');
      assert.equal((await state()).controls.find(c => c.id === 'hours').value, 0.3, 'decimal step accepted without arithmetic drift');
      await field('name').locator('input').fill('x'.repeat(1201));
      assert.equal(await field('name').locator('input').getAttribute('aria-invalid'), 'true', 'host schema text bound enforced');
      await page.locator('button[type=submit]').click();
      assert.equal(await draftCount(), 0);
      await field('name').locator('input').fill('Lin');

      const details = field('help').locator('details');
      await details.locator('summary').click();
      assert.equal(await details.evaluate(node => node.open), true);
      await details.locator('summary').press('Escape');
      assert.equal(await details.evaluate(node => node.open), false);
      const badge = field('estimate').locator('details');
      await page.locator('#outside').focus();
      await badge.locator('summary').focus();
      assert.equal(await badge.evaluate(node => node.open), true, 'badge details available on keyboard focus');
      await badge.locator('summary').press('Escape');
      assert.equal(await badge.evaluate(node => node.open), false);
      await page.locator('#outside').focus();
      if (width < 500) {
        await badge.locator('summary').tap();
        assert.equal(await badge.evaluate(node => node.open), true, 'first touch opens badge');
      } else {
        await badge.locator('summary').hover();
        assert.equal(await badge.evaluate(node => node.open), true, 'mouse hover opens badge');
        await badge.locator('summary').click();
        assert.equal(await badge.evaluate(node => node.open), false, 'click toggles the already hovered native details');
      }
      await page.locator('#outside').focus();
      assert.equal(await badge.evaluate(node => node.open), false, 'badge closes on blur');
      await badge.locator('summary').dispatchEvent('pointerover', { pointerType: 'mouse' });
      assert.equal(await badge.evaluate(node => node.open), true, 'mouse hover reveals badge detail');
      await badge.locator('summary').dispatchEvent('pointerout', { pointerType: 'mouse', relatedTarget: null });
      assert.equal(await badge.evaluate(node => node.open), false, 'mouse exit closes unfocused badge');

      assert.equal(await field('routes').locator('.rai-control-slide-title').textContent(), 'North');
      await field('routes').locator('[data-action=next]').click();
      assert.equal(await field('routes').locator('.rai-control-slide-title').textContent(), 'South');
      assert.equal(await field('routes').locator('[data-action=next]').isDisabled(), true);
      await field('routes').locator('[data-action=previous]').click();
      assert.equal(await field('routes').locator('.rai-control-slide-title').textContent(), 'North');

      await page.locator('button[type=submit]').click();
      await page.waitForFunction(() => drafts.length === 1 && card.element.dataset.state === 'draft');
      const draft = await page.evaluate(() => drafts[0]);
      assert.deepEqual(JSON.parse(draft.slice(draft.indexOf('{'))), await state(), 'draft contains exact validated current values');
      await field('review').getByRole('button').click();
      await page.waitForFunction(() => drafts.length === 2);
      assert.ok((await page.evaluate(() => drafts[1])).includes('"Review choices"'), 'button reports its intent, not an arbitrary action');
      assert.equal(await page.evaluate(() => changes.every(value => !!RAIInteractiveVisualSchema.validate(value))), true);
      const edited = await state();
      assert.deepEqual(await page.evaluate(() => source), spec, 'renderer never mutates original model data');
      await page.evaluate(() => { const value = card.getSpec(); value.controls[0].label = 'mutated'; });
      assert.equal((await state()).controls[0].label, 'Review choices', 'getSpec is an independent snapshot');

      await mount(spec, edited);
      assert.deepEqual(await state(), edited, 'current restores all value fields');
      const renamed = copy(edited);
      renamed.title = 'Ignored stored title';
      renamed.controls[6].label = 'Ignored stored label';
      await mount(spec, renamed);
      assert.equal((await state()).title, spec.title);
      assert.equal((await state()).controls[6].label, spec.controls[6].label, 'restore values only');
      const other = copy(edited);
      other.id = 'another-card';
      await mount(spec, other);
      assert.deepEqual(await state(), spec, 'another stable card cannot restore values');
      const reordered = copy(edited);
      [reordered.controls[1], reordered.controls[2]] = [reordered.controls[2], reordered.controls[1]];
      await mount(spec, reordered);
      assert.deepEqual(await state(), spec, 'changed control structure rejects restore');
      const newOptions = copy(spec);
      newOptions.controls[4].options = [{ label: 'Window', value: 'window' }];
      await mount(newOptions, edited);
      assert.deepEqual(await state(), newOptions, 'restored values must satisfy current options');

      const hostile = copy(spec);
      hostile.title = '<img src=x onerror="window.executed=1">';
      hostile.controls[0].label = '<svg onload="window.executed=1">';
      hostile.controls[9].text = '<script>window.executed=1</script>';
      hostile.controls[10].items[0].text = '<iframe src="https://example.invalid/">';
      await mount(hostile);
      assert.equal(await page.locator('.rai-interactive-controls img,.rai-interactive-controls svg,.rai-interactive-controls script,.rai-interactive-controls iframe').count(), 0);
      assert.equal(await page.evaluate(() => window.executed), undefined);
      const invalid = { ...spec, html: '<b>not allowed</b>' };
      await mount(invalid);
      assert.equal(await page.locator('#host [role=alert]').count(), 1);
      assert.equal(await state(), null);
      await mount({ type: 'remove', id: 'travel-plan' });
      assert.equal(await state(), null, 'form renderer does not handle remove');

      const ready = copy(spec);
      ready.controls[6].value = 'Lin';
      await mount(ready);
      await page.evaluate(ready => {
        card.destroy();
        card = RAIInteractiveControls.mount(document.getElementById('host'), ready, {
          language: 'en', onChange() { throw new Error('persistence rejected'); },
          onApply() { return Promise.reject(new Error('composer rejected')); }
        });
      }, ready);
      await field('direct').locator('input').check();
      assert.equal((await state()).controls[1].checked, true);
      assert.match(await page.locator('.rai-controls-status').textContent(), /callback did not complete/);
      await page.locator('button[type=submit]').click();
      await page.waitForFunction(() => !card.element.querySelector('.rai-controls-error').hidden);
      assert.match(await page.locator('.rai-controls-error').textContent(), /could not be filled/);

      await page.evaluate(ready => {
        card.destroy();
        window.applied = 0;
        card = RAIInteractiveControls.mount(document.getElementById('host'), ready, {
          language: 'en', onApply() { applied++; return new Promise(resolve => { window.releaseApply = resolve; }); }
        });
        card.element.querySelector('form').requestSubmit();
        card.element.querySelector('form').requestSubmit();
      }, ready);
      assert.equal(await page.evaluate(() => applied), 1, 'pending apply is single flight');
      assert.equal(await page.locator('button[type=submit]').isDisabled(), true);
      await page.evaluate(() => { window.stale = card.element; card.destroy(); releaseApply(); });
      await page.waitForTimeout(20);
      await page.evaluate(() => {
        stale.querySelector('input[type=checkbox]').dispatchEvent(new Event('input', { bubbles: true }));
        stale.querySelector('[data-action=apply]').click();
        stale.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      assert.equal(await page.evaluate(() => applied), 1, 'destroy disconnects retained detached nodes');
      assert.equal(await state(), null);
      assert.equal(await page.locator('#neighbor').textContent(), 'Neighbor');
      await page.evaluate(ready => {
        card = RAIInteractiveControls.mount(document.getElementById('host'), ready, { language: 'en' });
      }, ready);
      assert.equal(await page.locator('button[type=submit]').isDisabled(), true, 'missing callback cannot claim draft success');
      assert.equal(await field('direct').locator('input').isEnabled(), true, 'local edits stay available');

      const geometry = [];
      for (const [viewportWidth, panelWidth] of [[320, 320], [1280, 368]]) {
        await page.setViewportSize({ width: viewportWidth, height: 1000 });
        await page.locator('#host').evaluate((node, width) => { node.style.width = width + 'px'; }, panelWidth);
        for (const theme of ['dark', 'light']) {
          await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
          const dimensions = await page.locator('#host').evaluate(host => {
            const root = host.querySelector('.rai-interactive-controls');
            const rect = host.getBoundingClientRect();
            const bounds = root.getBoundingClientRect();
            const overflowing = [...root.querySelectorAll('input,textarea,select,button,fieldset,details,.rai-control-slide')]
              .filter(node => node.getClientRects().length)
              .filter(node => { const child = node.getBoundingClientRect(); return child.left < rect.left - 1 || child.right > rect.right + 1; })
              .map(node => ({ tag: node.tagName, className: node.className }));
            return { width: rect.width, rootWidth: bounds.width, overflow: host.scrollWidth-host.clientWidth,
              documentOverflow: document.documentElement.scrollWidth-innerWidth, overflowing,
              background: getComputedStyle(root).backgroundColor, colorScheme: getComputedStyle(root).colorScheme };
          });
          assert.ok(Math.abs(dimensions.width-panelWidth)<1, 'fixture panel width');
          assert.ok(dimensions.rootWidth<=panelWidth+1 && dimensions.overflow<=1 && dimensions.documentOverflow<=1,
            'production CSS overflow: '+JSON.stringify({viewportWidth,panelWidth,theme,...dimensions}));
          assert.deepEqual(dimensions.overflowing, [], 'all visible controls fit the narrow panel');
          assert.equal(dimensions.colorScheme, theme, 'actual RAI theme CSS is active');
          geometry.push({ viewportWidth, panelWidth, theme, ...dimensions });
        }
      }
      assert.deepEqual(requests, [], 'render, input, buttons and submit never issue network requests');
      assert.deepEqual(pageErrors, []);
      results.push({ engine: engineName, width, language, passed: true, geometry,
        coverage: '13 controls + form, native semantics, exact number/step, required/text bounds, restore isolation, safe draft callbacks, failure/single-flight/destroy, literal hostile text, zero network' });
      await context.close();
      console.log('PASS ' + engineName + ' ' + width + 'px ' + language);
    }
  } finally { await browser.close(); }
}
(async () => {
  await run();
  console.log(JSON.stringify({ suite: 'interactive-controls-browser-regression', results }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
