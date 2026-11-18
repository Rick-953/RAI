(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./interactive-visual-schema'), require('./interactive-controls'));
  else root.RAIInteractiveVisuals = factory(root.RAIInteractiveVisualSchema, root.RAIInteractiveControls);
})(typeof window === 'object' ? window : globalThis, function (schema, formControls) {
  'use strict';
  let nextId = 0;

  function scanBlocks(content) {
    if (typeof content !== 'string' || content.length > schema.limits.maxContentLength) return [];
    const fences = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)(?:\r\n|\n|\r|$)/gm;
    const blocks = [];
    let open = null, match;
    while ((match = fences.exec(content))) {
      if (!open) {
        open = {
          marker: match[1], start: match.index, bodyStart: fences.lastIndex,
          visual: match[1] === '```' && match[2].trim() === 'rai_visual'
        };
      } else if (match[1][0] === open.marker[0] && match[1].length >= open.marker.length && !match[2].trim()) {
        if (open.visual && blocks.length < schema.limits.maxBlocks) {
          const spec = schema.parse(content.slice(open.bodyStart, match.index));
          if (spec) {
            const end = match.index + match[0].replace(/(?:\r\n|\n|\r)$/, '').length;
            blocks.push({ spec, raw: content.slice(open.start, end), start: open.start, end });
          }
        }
        open = null;
      }
    }
    return blocks;
  }

  function parseBlocks(content) {
    return scanBlocks(content).map(({ spec, raw }) => ({ spec, raw }));
  }

  function stripBlocks(content) {
    if (typeof content !== 'string') return '';
    let output = '', start = 0;
    for (const block of scanBlocks(content)) {
      output += content.slice(start, block.start);
      start = block.end;
    }
    return output + content.slice(start);
  }

  function segments(content) {
    const result = [];
    let start = 0;
    for (const block of scanBlocks(content)) {
      if (block.start > start) result.push({ text: content.slice(start, block.start) });
      result.push({ spec: block.spec });
      start = block.end;
    }
    if (start < content.length) result.push({ text: content.slice(start) });
    return result;
  }

  const keyFor = spec => spec.id || `${spec.type}:${spec.title}`;
  function collectLatest(messages, messageKey) {
    const result = new Map();
    for (const message of messages || []) {
      if (message.role !== 'assistant') continue;
      for (const { spec } of parseBlocks(message.content)) {
        const key = keyFor(spec);
        result.delete(key);
        if (spec.type !== 'remove') result.set(key, { spec, sourceId: message.id ?? null,
          sourceKey: typeof messageKey === 'function' ? messageKey(message) : message.id ?? null });
        while (result.size > schema.limits.maxBlocks) result.delete(result.keys().next().value);
      }
    }
    return Array.from(result.values());
  }

  function mount(container, input, options = {}) {
    if (!container?.ownerDocument || typeof container.appendChild !== 'function') {
      throw new TypeError('A DOM container is required');
    }
    const validated = schema.validate(input);
    if (validated?.type === 'form') return formControls.mount(container, validated, options);
    if (validated?.type === 'remove') throw new TypeError('Removal directives are not visual cards');
    const document = container.ownerDocument;
    const language = typeof options.language === 'string' ? options.language : document.documentElement.lang;
    const english = /^en(?:[-_]|$)/i.test(language);
    const t = (zh, en) => english ? en : zh;
    const element = (tag, className, content) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (content !== undefined) node.textContent = content;
      return node;
    };
    const root = element('section', 'rai-visual');
    root.lang = english ? 'en' : 'zh-CN';
    const original = validated;
    const onApply = typeof options.onApply === 'function' ? options.onApply : null;
    let destroyed = false;
    const handle = {
      element: root,
      getSpec: () => original ? schema.validate({ ...original,
        ...(original.type === 'budget' ? { budget } : {}),
        items: original.items.map((item, index) => ({ ...item,
          [original.type === 'checklist' ? 'checked' : 'value']: current[index] })) }) : null,
      destroy() {
        destroyed = true;
        root.removeEventListener('input', onInput);
        root.removeEventListener('click', onClick);
        root.remove();
      }
    };
    if (!original) {
      root.setAttribute('role', 'alert');
      root.textContent = t('无法解析可视化数据，请查看原始内容。', 'This visual could not be parsed. Please check the original content.');
      container.appendChild(root);
      return handle;
    }

    root.dataset.visualType = original.type;
    const id = 'rai-visual-' + (++nextId);
    const heading = element('div', 'rai-visual-heading');
    const title = element('span', 'rai-visual-title', original.title);
    title.id = id + '-title';
    root.setAttribute('aria-labelledby', title.id);
    const kind = original.type === 'budget' ? t('预算试算', 'Budget scenario')
      : original.type === 'comparison' ? t('同一度量对比', 'Same-metric comparison') : t('交互清单', 'Checklist');
    heading.append(title, element('span', 'rai-visual-kind', kind));
    root.appendChild(heading);
    const note = original.type === 'budget'
      ? t('计划值不代表真实报价。调整仅在本地生效，确认后填写草稿。', 'Planned amounts are not verified quotes. Changes stay local; confirmation fills a draft.')
      : original.type === 'comparison'
        ? t('各项使用同一单位，互不相加。点击项目可填写针对它的追问草稿。', 'All items use the same unit and are not added together. Click an item to draft a focused question.')
        : t('勾选仅记录本地状态，不代表已核实完成。确认后填写草稿。', 'Checks record local status, not verified completion. Confirmation fills a draft.');
    root.appendChild(element('p', 'rai-visual-note', note));
    const formatter = new Intl.NumberFormat(english ? 'en-US' : 'zh-CN', {
      maximumFractionDigits: original.type === 'budget' ? schema.limits.budgetDecimals : schema.limits.comparisonDecimals
    });
    const amount = value => formatter.format(value) + ' ' + original.unit;
    const quoted = value => JSON.stringify(value);
    const checkedLabel = value => value ? t('已勾选', 'checked') : t('未勾选', 'unchecked');
    const restored = schema.validate(options.current);
    const initial = restored && restored.type === original.type && restored.title === original.title
      && restored.id === original.id && restored.unit === original.unit
      && restored.items.length === original.items.length && restored.items.every((item, index) => item.label === original.items[index].label)
      ? restored : original;
    const current = initial.items.map(item => original.type === 'checklist' ? item.checked : item.value);
    let budget = initial.budget, appliedSnapshot = null, applyFailed = false;
    const controls = [];
    const snapshot = () => JSON.stringify([budget ?? null, current]);
    const initialSnapshot = JSON.stringify([original.budget ?? null, original.items.map(item => original.type === 'checklist' ? item.checked : item.value)]);
    const status = element('p', 'rai-visual-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const error = element('p', 'rai-visual-error');
    error.id = id + '-error';
    error.setAttribute('role', 'alert');
    error.hidden = true;
    let totalNode, balanceNode, balanceLabel, meter, meterBar, progressText, applyButton, resetButton;

    function button(label, action) {
      const node = element('button', 'rai-visual-button', label);
      node.type = 'button';
      node.dataset.action = action;
      return node;
    }

    function progress(max) {
      meter = element('div', 'rai-visual-meter');
      meter.setAttribute('role', 'progressbar');
      meter.setAttribute('aria-label', t('进度', 'Progress'));
      meter.setAttribute('aria-valuemin', '0');
      meter.setAttribute('aria-valuemax', String(max));
      meterBar = element('span', 'rai-visual-bar');
      meter.appendChild(meterBar);
      root.appendChild(meter);
    }

    function sliderMax(value) {
      const base = Math.pow(10, Math.floor(Math.log10(Math.max(1, value))));
      return Math.min(schema.limits.maxValue, Math.ceil(Math.max(1, value) / base) * base);
    }

    function amountControl(label, value, index, initialMax) {
      const row = element('div', 'rai-visual-amount-row');
      const description = element('div', 'rai-visual-amount-label');
      const originalValue = index === -1 ? original.budget : original.items[index].value;
      description.append(element('span', '', label), element('small', 'rai-visual-original', t('原值：', 'Original: ') + amount(originalValue)));
      const numeric = element('input', 'rai-visual-number');
      const range = element('input', 'rai-visual-range');
      numeric.type = 'number';
      numeric.inputMode = 'decimal';
      range.type = 'range';
      for (const control of [numeric, range]) {
        control.min = '0';
        control.max = String(control === numeric ? schema.limits.maxValue : initialMax);
        control.step = '0.01';
        control.value = String(value);
        control.dataset.field = index === -1 ? 'budget' : 'item-' + index;
        control.setAttribute('aria-label', label + ' (' + original.unit + ')' + (control === range ? t('滑块', ' slider') : ''));
        control.setAttribute('aria-describedby', error.id);
      }
      row.append(description, numeric, range);
      root.appendChild(row);
      controls.push({ numeric, range, index, initialMax, invalid: false });
    }

    if (original.type === 'budget') {
      const total = schema.calculateBudget(budget, current).total;
      amountControl(t('总预算', 'Budget'), budget, -1, sliderMax(Math.max(budget, total, 1) * 2));
      original.items.forEach((item, index) => amountControl(item.label, current[index], index, sliderMax(Math.max(budget, item.value * 2, 1))));
      const summary = element('div', 'rai-visual-summary');
      const totalGroup = element('div');
      totalNode = element('strong', 'rai-visual-metric');
      totalGroup.append(element('span', 'rai-visual-metric-label', t('计划合计', 'Planned total')), totalNode);
      const balanceGroup = element('div');
      balanceLabel = element('span', 'rai-visual-metric-label');
      balanceNode = element('strong', 'rai-visual-metric');
      balanceGroup.append(balanceLabel, balanceNode);
      summary.append(totalGroup, balanceGroup);
      root.appendChild(summary);
      progress(100);
    } else if (original.type === 'comparison') {
      root.appendChild(element('p', 'rai-visual-unit', t('单位：', 'Unit: ') + original.unit));
      const lower = Math.min(0, ...current), upper = Math.max(0, ...current);
      const extent = upper - lower || 1;
      original.items.forEach((item, index) => {
        const row = button('', 'inspect');
        row.className = 'rai-visual-comparison-row';
        row.dataset.index = String(index);
        row.disabled = !onApply;
        row.setAttribute('aria-label', t('追问：', 'Ask about: ') + item.label + ' (' + amount(item.value) + ')');
        row.setAttribute('aria-pressed', 'false');
        const caption = element('span', 'rai-visual-comparison-caption');
        caption.append(element('span', '', item.label), element('strong', '', amount(item.value)));
        const track = element('span', 'rai-visual-track');
        track.setAttribute('aria-hidden', 'true');
        const zero = element('span', 'rai-visual-zero');
        zero.style.left = (-lower / extent * 100) + '%';
        const bar = element('span', 'rai-visual-bar');
        bar.style.left = ((Math.min(0, item.value) - lower) / extent * 100) + '%';
        bar.style.width = (Math.abs(item.value) / extent * 100) + '%';
        track.append(zero, bar);
        row.append(caption, track);
        root.appendChild(row);
      });
    } else {
      progressText = element('p', 'rai-visual-progress-text');
      root.appendChild(progressText);
      progress(original.items.length);
      original.items.forEach((item, index) => {
        const row = element('label', 'rai-visual-check-row');
        const checkbox = element('input');
        checkbox.type = 'checkbox';
        checkbox.checked = current[index];
        checkbox.setAttribute('aria-label', item.label);
        const label = element('span');
        label.append(element('span', '', item.label), element('small', 'rai-visual-original', t('初始：', 'Initially: ') + checkedLabel(item.checked)));
        row.append(checkbox, label);
        root.appendChild(row);
        controls.push({ checkbox, index });
      });
    }
    root.appendChild(error);
    if (original.type !== 'comparison') {
      const actions = element('div', 'rai-visual-actions');
      resetButton = button(t('还原初始数据', 'Reset to original'), 'reset');
      applyButton = button(t('确认用于后续', 'Use in follow-up'), 'apply');
      actions.append(resetButton, applyButton);
      root.appendChild(actions);
    }
    root.appendChild(status);

    function refresh() {
      const invalid = controls.some(control => control.invalid);
      const state = snapshot();
      const dirty = state !== appliedSnapshot && (state !== initialSnapshot || appliedSnapshot !== null);
      root.classList.toggle('is-dirty', dirty);
      root.dataset.state = dirty ? 'dirty' : appliedSnapshot !== null ? 'draft' : 'initial';
      error.hidden = !invalid && !applyFailed;
      error.textContent = invalid
        ? t('请输入 0–1,000,000,000 之间、最多两位小数的金额。合计仍使用上次有效值。', 'Enter an amount from 0 to 1,000,000,000 with at most two decimal places. Totals still use the last valid value.')
        : applyFailed ? t('未能填写草稿，请重试。', 'The draft could not be filled. Please try again.') : '';
      status.textContent = !onApply ? t('本地交互；宿主尚未连接草稿入口。', 'Local interaction; the host has not connected a draft input.')
        : dirty ? t('已修改 · 未用于后续', 'Modified · not yet used in a follow-up')
          : appliedSnapshot !== null ? t('已填写草稿 · 尚未发送', 'Draft filled · not sent')
            : t('本地交互 · 不会自动发送', 'Local interaction · never sent automatically');
      if (applyButton) applyButton.disabled = !onApply || invalid;
      if (resetButton) resetButton.disabled = state === initialSnapshot && !invalid;
      if (original.type === 'budget') {
        const totals = schema.calculateBudget(budget, current);
        totalNode.textContent = amount(totals.total);
        balanceLabel.textContent = totals.overspend ? t('超出预算', 'Over budget') : t('预算结余', 'Remaining');
        balanceNode.textContent = amount(totals.overspend || totals.remaining);
        root.classList.toggle('is-over-budget', totals.overspend > 0);
        const percent = Math.min(100, budget ? totals.total / budget * 100 : totals.total ? 100 : 0);
        meterBar.style.width = percent + '%';
        meter.setAttribute('aria-valuenow', String(percent));
        meter.setAttribute('aria-valuetext', t('计划合计 ', 'Planned total ') + amount(totals.total) + t('；预算 ', '; budget ') + amount(budget));
      } else if (original.type === 'checklist') {
        const count = current.filter(Boolean).length;
        progressText.textContent = t('已勾选 ', 'Checked ') + count + ' / ' + current.length + ' · ' + Math.round(count / current.length * 100) + '%';
        meter.setAttribute('aria-valuenow', String(count));
        meterBar.style.width = (count / current.length * 100) + '%';
      }
    }

    function itemLines(values) {
      return original.items.map((item, index) => (index + 1) + '. ' + quoted(item.label) + ': '
        + (original.type === 'checklist' ? checkedLabel(values[index]) : amount(values[index]))).join('\n');
    }

    function followUp(index) {
      const source = t('来源标题：', 'Source title: ') + quoted(original.title);
      if (original.type === 'comparison') {
        return source + '\n' + t('请针对第 ', 'Please focus on item ') + (index + 1) + ': '
          + quoted(original.items[index].label) + ' (' + amount(current[index]) + ')'
          + t(' 继续分析差异与取舍。各项是同一度量的独立选项，请勿相加；区分事实与假设。\n原始对比参数：\n',
            '. Explain differences and trade-offs. These are independent options on one metric; do not sum them. Distinguish facts from assumptions.\nOriginal comparison parameters:\n')
          + itemLines(current);
      }
      const before = original.items.map(item => original.type === 'checklist' ? item.checked : item.value);
      const changes = [];
      if (original.type === 'budget' && budget !== original.budget) {
        changes.push(t('总预算：', 'Budget: ') + amount(original.budget) + ' → ' + amount(budget));
      }
      original.items.forEach((item, itemIndex) => {
        if (before[itemIndex] !== current[itemIndex]) {
          const format = original.type === 'checklist' ? checkedLabel : amount;
          changes.push((itemIndex + 1) + '. ' + quoted(item.label) + ': ' + format(before[itemIndex]) + ' → ' + format(current[itemIndex]));
        }
      });
      const lines = [source, original.type === 'budget'
        ? t('请用以下本地预算试算继续讨论；计划值不代表真实报价。', 'Continue with this local budget scenario; planned amounts are not verified quotes.')
        : t('请按以下本地清单状态继续讨论；勾选不代表已核实完成。', 'Continue with this local checklist status; checks do not establish verified completion.'),
      t('变更（相对初始数据）：', 'Changes from the original:'),
      changes.join('\n') || t('无变更。', 'No changes.'),
      t('初始参数：', 'Original parameters:')];
      if (original.type === 'budget') lines.push(t('总预算：', 'Budget: ') + amount(original.budget));
      lines.push(itemLines(before), t('当前参数：', 'Current parameters:'));
      if (original.type === 'budget') lines.push(t('总预算：', 'Budget: ') + amount(budget));
      lines.push(itemLines(current));
      if (original.type === 'budget') {
        const totals = schema.calculateBudget(budget, current);
        lines.push(t('计划合计：', 'Planned total: ') + amount(totals.total) + t('；', '; ')
          + (totals.overspend ? t('超出预算：', 'Over budget: ') : t('预算结余：', 'Remaining: ')) + amount(totals.overspend || totals.remaining));
      } else lines.push(t('勾选进度：', 'Checked progress: ') + current.filter(Boolean).length + '/' + current.length);
      return lines.join('\n');
    }

    function onInput(event) {
      if (destroyed) return;
      const control = controls.find(entry => entry.numeric === event.target || entry.range === event.target || entry.checkbox === event.target);
      if (!control) return;
      applyFailed = false;
      if (control.checkbox) current[control.index] = control.checkbox.checked;
      else {
        const value = event.target.valueAsNumber;
        control.invalid = !schema.isBudgetAmount(value);
        control.numeric.setAttribute('aria-invalid', String(control.invalid));
        if (!control.invalid) {
          if (control.index === -1) budget = value;
          else current[control.index] = value;
          if (value > Number(control.range.max)) control.range.max = String(sliderMax(value * 1.25));
          control.range.value = String(value);
          if (event.target === control.range) control.numeric.value = String(value);
        }
      }
      refresh();
      options.onChange?.(handle.getSpec());
    }

    function onClick(event) {
      if (destroyed) return;
      const target = event.target.closest?.('button');
      if (!target || !root.contains(target) || target.disabled) return;
      if (target.dataset.action === 'reset') {
        budget = original.budget;
        original.items.forEach((item, index) => { current[index] = original.type === 'checklist' ? item.checked : item.value; });
        controls.forEach(control => {
          control.invalid = false;
          if (control.checkbox) control.checkbox.checked = current[control.index];
          else {
            const value = control.index === -1 ? budget : current[control.index];
            control.numeric.value = String(value);
            control.numeric.setAttribute('aria-invalid', 'false');
            control.range.max = String(control.initialMax);
            control.range.value = String(value);
          }
        });
        applyFailed = false;
      } else if (onApply && (target.dataset.action === 'apply' || target.dataset.action === 'inspect')) {
        if (controls.some(control => control.invalid)) return;
        const index = Number(target.dataset.index);
        try {
          onApply(followUp(index));
          appliedSnapshot = snapshot();
          applyFailed = false;
          if (original.type === 'comparison') {
            root.querySelectorAll('[data-action="inspect"]').forEach(row => row.setAttribute('aria-pressed', String(Number(row.dataset.index) === index)));
          }
        } catch (_) { applyFailed = true; }
      }
      refresh();
      if (target.dataset.action === 'reset') options.onChange?.(handle.getSpec());
    }

    root.addEventListener('input', onInput);
    root.addEventListener('click', onClick);
    refresh();
    container.appendChild(root);
    return handle;
  }

  return Object.freeze({ parseBlocks, stripBlocks, segments, collectLatest, keyFor, mount });
});
