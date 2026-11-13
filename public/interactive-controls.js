(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./interactive-visual-schema'));
  else root.RAIInteractiveControls = factory(root.RAIInteractiveVisualSchema);
})(typeof window === 'object' ? window : globalThis, function (schema) {
  'use strict';
  if (typeof schema?.validate !== 'function') throw new TypeError('Interactive controls require schema.validate');
  let nextId = 0;
  const valueKeys = Object.freeze({
    checkbox: 'checked', radio: 'value', segmented: 'value', select: 'value', slider: 'value',
    input: 'value', textarea: 'value', date: 'value', pressable: 'selected'
  });
  const clone = value => JSON.parse(JSON.stringify(value));

  function validatedForm(value) {
    const result = schema.validate(value);
    return result?.type === 'form' ? result : null;
  }

  function restoreValues(original, current) {
    const saved = validatedForm(current);
    if (!saved || saved.id !== original.id || saved.controls.length !== original.controls.length
      || saved.controls.some((control, index) => control.kind !== original.controls[index].kind
        || control.id !== original.controls[index].id)) return clone(original);
    const restored = clone(original);
    restored.controls.forEach((control, index) => {
      const key = valueKeys[control.kind];
      if (key) control[key] = saved.controls[index][key];
    });
    // Stored labels/options/bounds never replace the new model-provided structure.
    return clone(validatedForm(restored) || original);
  }

  function mount(container, spec, options = {}) {
    if (!container?.ownerDocument || typeof container.appendChild !== 'function') {
      throw new TypeError('A DOM container is required');
    }
    const document = container.ownerDocument;
    const language = typeof options.language === 'string' ? options.language : document.documentElement.lang;
    const english = /^en(?:[-_]|$)/i.test(language);
    const t = (zh, en) => english ? en : zh;
    const onApply = typeof options.onApply === 'function' ? options.onApply : null;
    const onChange = typeof options.onChange === 'function' ? options.onChange : null;
    const create = (tag, className, text) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const root = create('section', 'rai-visual rai-interactive-controls');
    root.lang = english ? 'en' : 'zh-CN';
    const listeners = [];
    let destroyed = false;
    let original = validatedForm(spec);
    let current = original ? restoreValues(original, options.current) : null;
    const handle = Object.freeze({
      element: root,
      getSpec: () => current ? clone(current) : null,
      destroy() {
        if (destroyed) return;
        destroyed = true;
        listeners.forEach(([event, listener]) => root.removeEventListener(event, listener));
        listeners.length = 0;
        root.remove();
        current = null;
        original = null;
      }
    });
    if (!original) {
      root.setAttribute('role', 'alert');
      root.textContent = t('无法解析交互表单，请查看原始内容。', 'This form could not be parsed. Please check the original content.');
      container.appendChild(root);
      return handle;
    }

    const prefix = 'rai-controls-' + (++nextId);
    const title = create('h3', 'rai-visual-title rai-controls-title', original.title);
    title.id = prefix + '-title';
    root.setAttribute('aria-labelledby', title.id);
    root.dataset.visualType = 'form';
    root.appendChild(title);
    const form = create('form', 'rai-controls-form');
    form.noValidate = true;
    const status = create('p', 'rai-visual-status rai-controls-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const formError = create('p', 'rai-visual-error rai-controls-error');
    formError.setAttribute('role', 'alert');
    formError.hidden = true;
    const bindings = new Map();
    const errors = new Map();
    const applyButtons = [];
    const carousels = new Map();
    let busy = false;
    let revision = 0;
    let appliedRevision = -1;
    let applyFailed = false;
    let changeFailed = false;
    let pointerSummary = null;

    function listen(event, listener) {
      root.addEventListener(event, listener);
      listeners.push([event, listener]);
    }

    function button(label, action) {
      const node = create('button', 'rai-visual-button rai-control-button', label);
      node.type = 'button';
      node.dataset.action = action;
      return node;
    }

    function refreshStatus() {
      status.textContent = changeFailed
        ? t('本地值已更新，但更改回调未完成。', 'Local values changed, but the change callback did not complete.')
        : !onApply ? t('本地交互；尚未连接草稿入口。', 'Local interaction; no draft input is connected.')
          : busy ? t('正在填写草稿…', 'Filling the draft…')
            : appliedRevision === revision ? t('已填写草稿 · 尚未发送', 'Draft filled · not sent')
              : revision ? t('已修改 · 不会自动发送', 'Modified · never sent automatically')
                : t('本地交互 · 不会自动发送', 'Local interaction · never sent automatically');
      root.dataset.state = busy ? 'applying' : appliedRevision === revision ? 'draft' : revision ? 'dirty' : 'initial';
      form.setAttribute('aria-busy', String(busy));
      applyButtons.forEach(node => { node.disabled = !onApply || busy; });
      formError.hidden = !applyFailed;
      formError.textContent = applyFailed ? t('未能填写草稿，请重试。', 'The draft could not be filled. Please try again.') : '';
    }

    function setError(binding, message) {
      binding.error.textContent = message;
      binding.error.hidden = !message;
      binding.inputs.forEach(input => input.setAttribute('aria-invalid', String(!!message)));
      if (message) errors.set(binding.index, message);
      else errors.delete(binding.index);
    }

    function validationMessage(binding) {
      const requiredBlank = binding.inputs.find(input => input.required && !input.value.trim());
      if (requiredBlank) return t('请填写此项。', 'Please fill in this field.');
      const invalid = binding.inputs.find(input => !input.checkValidity());
      if (!invalid) return '';
      return binding.control.kind === 'slider'
        ? t('请输入范围内且符合步长的有效数值。', 'Enter a valid number within the range and step.')
        : t('请检查此项的值。', 'Please check this field.');
    }

    function notifyChange() {
      if (!onChange) return;
      const changedAt = revision;
      try {
        const result = onChange(clone(current));
        Promise.resolve(result).catch(() => {
          if (!destroyed && changedAt === revision) { changeFailed = true; refreshStatus(); }
        });
      } catch (_) { changeFailed = true; }
    }

    function changeValue(binding, value, source) {
      const key = valueKeys[binding.control.kind];
      const candidate = clone(current);
      candidate.controls[binding.index][key] = value;
      const valid = validatedForm(candidate);
      if (!valid) {
        setError(binding, t('此值不符合表单格式，请检查。', 'This value does not match the form format. Please check it.'));
        return false;
      }
      if (current.controls[binding.index][key] !== valid.controls[binding.index][key]) {
        current = clone(valid);
        revision += 1;
        applyFailed = false;
        changeFailed = false;
        notifyChange();
      }
      if (destroyed) return true;
      if (binding.control.kind === 'slider') {
        // Preserve typed number text; only the companion control is synchronized.
        binding.inputs.forEach(input => { if (input !== source) input.value = String(value); });
      } else if (binding.control.kind === 'pressable') {
        binding.inputs[0].setAttribute('aria-pressed', String(value));
      }
      setError(binding, validationMessage(binding));
      refreshStatus();
      return true;
    }

    function bindControl(control, index, wrapper, inputs) {
      const error = create('p', 'rai-control-error');
      error.id = prefix + '-error-' + index;
      error.setAttribute('role', 'alert');
      error.hidden = true;
      wrapper.appendChild(error);
      inputs.forEach(input => {
        input.dataset.controlIndex = String(index);
        input.setAttribute('aria-describedby', error.id);
      });
      const binding = { index, control, inputs, error };
      bindings.set(index, binding);
      return binding;
    }

    current.controls.forEach((control, index) => {
      const id = prefix + '-field-' + index;
      const wrapper = create('div', 'rai-control rai-control-' + control.kind);
      wrapper.dataset.controlId = control.id;
      wrapper.dataset.controlKind = control.kind;
      const label = create('label', 'rai-control-label', control.label);
      label.htmlFor = id;
      if (control.kind === 'button') {
        const action = button(control.label, 'apply');
        action.dataset.controlIndex = String(index);
        applyButtons.push(action);
        wrapper.appendChild(action);
      } else if (control.kind === 'radio' || control.kind === 'segmented') {
        const group = create('fieldset', 'rai-control-options');
        group.appendChild(create('legend', 'rai-control-label', control.label));
        const inputs = control.options.map((option, optionIndex) => {
          const choice = create('label', 'rai-control-option');
          const input = create('input', 'rai-control-radio');
          input.type = 'radio';
          input.name = id;
          input.id = id + '-' + optionIndex;
          input.value = option.value;
          input.checked = control.value === option.value;
          choice.append(input, create('span', 'rai-control-option-label', option.label));
          group.appendChild(choice);
          return input;
        });
        wrapper.appendChild(group);
        bindControl(control, index, wrapper, inputs);
      } else if (control.kind === 'checkbox') {
        const input = create('input', 'rai-control-checkbox');
        input.type = 'checkbox';
        input.id = id;
        input.checked = control.checked;
        label.prepend(input);
        wrapper.appendChild(label);
        bindControl(control, index, wrapper, [input]);
      } else if (control.kind === 'select') {
        const input = create('select', 'rai-control-select');
        input.id = id;
        control.options.forEach(option => {
          const node = create('option', '', option.label);
          node.value = option.value;
          input.appendChild(node);
        });
        input.value = control.value;
        wrapper.append(label, input);
        bindControl(control, index, wrapper, [input]);
      } else if (control.kind === 'slider') {
        const numeric = create('input', 'rai-control-number');
        numeric.type = 'number';
        numeric.inputMode = 'decimal';
        numeric.required = true;
        numeric.id = id;
        const range = create('input', 'rai-control-range');
        range.type = 'range';
        range.id = id + '-range';
        range.setAttribute('aria-label', control.label + t('（滑块）', ' (slider)'));
        for (const input of [numeric, range]) {
          input.min = String(control.min);
          input.max = String(control.max);
          input.step = String(control.step);
          input.value = String(control.value);
        }
        const unit = create('span', 'rai-control-unit', control.unit);
        unit.id = id + '-unit';
        numeric.setAttribute('aria-labelledby', id + '-label ' + unit.id);
        label.id = id + '-label';
        wrapper.append(label, numeric, unit, range);
        bindControl(control, index, wrapper, [numeric, range]);
      } else if (control.kind === 'input' || control.kind === 'textarea' || control.kind === 'date') {
        const input = create(control.kind === 'textarea' ? 'textarea' : 'input', 'rai-control-input');
        if (control.kind !== 'textarea') input.type = control.kind === 'date' ? 'date' : 'text';
        input.id = id;
        input.value = control.value;
        if (control.kind !== 'date') {
          input.required = control.required;
          input.placeholder = control.placeholder;
        }
        wrapper.append(label, input);
        bindControl(control, index, wrapper, [input]);
      } else if (control.kind === 'popover' || control.kind === 'badge') {
        const details = create('details', 'rai-control-details');
        const summary = create('summary', control.kind === 'badge' ? 'rai-control-badge' : 'rai-control-summary', control.label);
        const text = create('p', 'rai-control-detail-text', control.text);
        text.id = id + '-detail';
        summary.setAttribute('aria-controls', text.id);
        if (control.kind === 'badge') {
          details.dataset.badgeDetails = 'true';
          summary.setAttribute('aria-describedby', text.id);
        }
        details.append(summary, text);
        wrapper.appendChild(details);
      } else if (control.kind === 'carousel') {
        const heading = create('h4', 'rai-control-label', control.label);
        heading.id = id;
        const carousel = create('section', 'rai-control-carousel');
        carousel.setAttribute('aria-labelledby', id);
        carousel.setAttribute('aria-roledescription', t('轮播', 'carousel'));
        const slide = create('article', 'rai-control-slide');
        slide.setAttribute('role', 'group');
        slide.setAttribute('aria-roledescription', t('幻灯片', 'slide'));
        const slideTitle = create('h5', 'rai-control-slide-title');
        const slideText = create('p', 'rai-control-slide-text');
        slide.append(slideTitle, slideText);
        const actions = create('div', 'rai-control-carousel-actions');
        const previous = button(t('上一项', 'Previous'), 'previous');
        const next = button(t('下一项', 'Next'), 'next');
        previous.dataset.controlIndex = next.dataset.controlIndex = String(index);
        previous.setAttribute('aria-label', control.label + t('：上一项', ': previous'));
        next.setAttribute('aria-label', control.label + t('：下一项', ': next'));
        const position = create('span', 'rai-control-carousel-position');
        position.setAttribute('role', 'status');
        position.setAttribute('aria-live', 'polite');
        actions.append(previous, position, next);
        carousel.append(slide, actions);
        wrapper.append(heading, carousel);
        const state = { index: 0, control, slide, slideTitle, slideText, previous, next, position };
        carousels.set(index, state);
        refreshCarousel(state);
      } else if (control.kind === 'pressable') {
        const toggle = button('', 'toggle');
        toggle.classList.add('rai-control-pressable');
        toggle.setAttribute('aria-pressed', String(control.selected));
        toggle.setAttribute('aria-label', control.label);
        toggle.append(create('span', 'rai-control-label', control.label), create('span', 'rai-control-pressable-text', control.text));
        wrapper.appendChild(toggle);
        bindControl(control, index, wrapper, [toggle]);
      }
      form.appendChild(wrapper);
    });

    function refreshCarousel(state) {
      const item = state.control.items[state.index];
      state.slideTitle.textContent = item.title;
      state.slideText.textContent = item.text;
      const position = (state.index + 1) + ' / ' + state.control.items.length;
      state.slide.setAttribute('aria-label', position);
      state.position.textContent = position;
      state.previous.disabled = state.index === 0;
      state.next.disabled = state.index === state.control.items.length - 1;
    }

    const submit = button(original.submitLabel, 'submit');
    submit.type = 'submit';
    applyButtons.push(submit);
    form.append(submit, formError, status);
    root.appendChild(form);

    function handleValueEvent(event) {
      if (destroyed) return;
      const target = event.target;
      if (!target?.dataset || target.dataset.controlIndex === undefined) return;
      const binding = bindings.get(Number(target.dataset.controlIndex));
      if (!binding || !binding.inputs.includes(target)) return;
      const kind = binding.control.kind;
      if (kind === 'pressable') return;
      if (kind === 'slider') {
        const message = validationMessage(binding);
        // An invalid numeric entry must not replace the last valid number or its slider.
        if (target.validity.badInput || target.value === '' || !target.checkValidity()) {
          setError(binding, message);
          return;
        }
        changeValue(binding, target.valueAsNumber, target);
      } else if (kind === 'checkbox') changeValue(binding, target.checked, target);
      else if (kind === 'radio' || kind === 'segmented') {
        if (target.checked) changeValue(binding, target.value, target);
      } else changeValue(binding, target.value, target);
    }

    async function apply(buttonLabel) {
      if (destroyed || busy || !onApply) return;
      // Flush programmatic/autofill changes as well as ordinary input events.
      for (const binding of bindings.values()) {
        if (binding.control.kind === 'pressable') continue;
        const checked = binding.inputs.find(input => input.checked);
        if ((binding.control.kind === 'radio' || binding.control.kind === 'segmented') && !checked) {
          setError(binding, t('请选择一项。', 'Please choose an option.'));
          continue;
        }
        const target = checked || binding.inputs[0];
        handleValueEvent({ target });
        if (destroyed) return;
        const message = validationMessage(binding);
        if (message) setError(binding, message);
      }
      if (errors.size) {
        bindings.get(errors.keys().next().value)?.inputs[0]?.focus();
        return;
      }
      const submittedAt = revision;
      const payload = handle.getSpec();
      const text = [
        buttonLabel
          ? t('我选择了按钮：', 'I selected the button: ') + JSON.stringify(buttonLabel)
          : t('请根据当前表单继续讨论：', 'Please continue using the current form: '),
        JSON.stringify(payload, null, 2)
      ].join('\n');
      busy = true;
      applyFailed = false;
      refreshStatus();
      try {
        const result = await onApply(text);
        if (destroyed) return;
        if (result === false) throw new Error('Draft callback rejected');
        appliedRevision = submittedAt;
      } catch (_) { if (!destroyed) applyFailed = true; }
      finally {
        if (!destroyed) { busy = false; refreshStatus(); }
      }
    }

    listen('input', handleValueEvent);
    listen('change', handleValueEvent);
    listen('submit', event => {
      event.preventDefault();
      if (event.target === form) void apply();
    });
    listen('click', event => {
      if (destroyed) return;
      pointerSummary = null;
      const action = event.target.closest?.('button[data-action]');
      if (!action || !root.contains(action) || action.disabled) return;
      const index = Number(action.dataset.controlIndex);
      if (action.dataset.action === 'apply') void apply(original.controls[index].label);
      else if (action.dataset.action === 'toggle') {
        const binding = bindings.get(index);
        changeValue(binding, !current.controls[index].selected, action);
      } else if (action.dataset.action === 'previous' || action.dataset.action === 'next') {
        const state = carousels.get(index);
        state.index += action.dataset.action === 'next' ? 1 : -1;
        refreshCarousel(state);
      }
    });
    listen('pointerdown', event => {
      pointerSummary = event.target.closest?.('[data-badge-details] > summary') || null;
    });
    listen('pointercancel', () => { pointerSummary = null; });
    listen('pointerover', event => {
      const details = event.target.closest?.('[data-badge-details]');
      if (event.pointerType === 'mouse' && details) details.open = true;
    });
    listen('pointerout', event => {
      const details = event.target.closest?.('[data-badge-details]');
      if (details && !details.contains(event.relatedTarget) && !details.contains(document.activeElement)) details.open = false;
    });
    listen('focusin', event => {
      const summary = event.target.closest?.('[data-badge-details] > summary');
      if (summary && pointerSummary !== summary) summary.parentElement.open = true;
    });
    listen('focusout', event => {
      const details = event.target.closest?.('[data-badge-details]');
      if (details && !details.contains(event.relatedTarget)) details.open = false;
    });
    listen('keydown', event => {
      if (event.key !== 'Escape') return;
      const details = event.target.closest?.('details');
      if (details?.open && root.contains(details)) {
        event.preventDefault();
        event.stopPropagation();
        details.open = false;
        details.querySelector('summary').focus();
      }
    });
    refreshStatus();
    container.appendChild(root);
    return handle;
  }

  return Object.freeze({ mount });
});
