(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RAIInteractiveVisualSchema = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';

  const limits = Object.freeze({
    maxItems: 24, maxTitleLength: 120, maxLabelLength: 120, maxUnitLength: 16,
    maxValue: 1000000000, budgetDecimals: 2, comparisonDecimals: 6,
    maxBlockLength: 16384, maxBlocks: 8, maxContentLength: 1000000,
    maxControls: 16, maxTextLength: 1200, maxStateLength: 32768
  });
  const fields = {
    budget: ['type', 'title', 'unit', 'budget', 'items'],
    comparison: ['type', 'title', 'unit', 'items'],
    checklist: ['type', 'title', 'items'],
    form: ['type', 'id', 'title', 'submitLabel', 'controls'],
    remove: ['type', 'id']
  };
  const controlFields = {
    button: [], checkbox: ['checked'],
    radio: ['options', 'value'], segmented: ['options', 'value'], select: ['options', 'value'],
    slider: ['min', 'max', 'step', 'value', 'unit'],
    input: ['value', 'placeholder', 'required'], textarea: ['value', 'placeholder', 'required'],
    date: ['value'], popover: ['text'], carousel: ['items'],
    pressable: ['text', 'selected'], badge: ['text']
  };

  // Read only own data properties; model data never supplies accessors or prototypes.
  function record(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const names = Reflect.ownKeys(value);
    if (names.length !== keys.length || names.some(name => !keys.includes(name))) return null;
    const result = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      result[key] = descriptor.value;
    }
    return result;
  }

  function array(value) {
    if (!Array.isArray(value) || value.length < 1 || value.length > limits.maxItems) return null;
    if (Reflect.ownKeys(value).length !== value.length + 1) return null;
    const result = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
      result.push(descriptor.value);
    }
    return result;
  }

  function text(value, maxLength) {
    return typeof value === 'string' && value.length <= maxLength && value.trim().length > 0
      && !/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u.test(value);
  }

  function number(value, decimals, signed) {
    return typeof value === 'number' && Number.isFinite(value)
      && value >= (signed ? -limits.maxValue : 0) && value <= limits.maxValue
      && Number(value.toFixed(decimals)) === value;
  }

  const isBudgetAmount = value => number(value, limits.budgetDecimals, false);
  const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value);
  const freeText = (value, max = limits.maxTextLength) => typeof value === 'string' && value.length <= max
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value);

  function control(value) {
    const kind = Object.getOwnPropertyDescriptor(value || {}, 'kind')?.value;
    if (typeof kind !== 'string' || !Object.hasOwn(controlFields, kind)) return null;
    const result = record(value, ['kind', 'id', 'label', ...controlFields[kind]]);
    if (!result || !identifier(result.id) || !text(result.label, limits.maxLabelLength)) return null;
    if (['checkbox', 'pressable'].includes(kind) && typeof result[kind === 'checkbox' ? 'checked' : 'selected'] !== 'boolean') return null;
    if (['radio', 'segmented', 'select'].includes(kind)) {
      const options = array(result.options);
      if (!options) return null;
      result.options = [];
      const values = new Set();
      for (const option of options) {
        const entry = record(option, ['label', 'value']);
        if (!entry || !text(entry.label, limits.maxLabelLength) || !text(entry.value, limits.maxLabelLength) || values.has(entry.value)) return null;
        values.add(entry.value);
        result.options.push(Object.freeze(entry));
      }
      if (!values.has(result.value)) return null;
      Object.freeze(result.options);
    }
    if (kind === 'slider') {
      if (![result.min, result.max, result.step, result.value].every(value => number(value, 6, true))
        || result.min >= result.max || result.step <= 0 || result.step > result.max - result.min
        || result.value < result.min || result.value > result.max || !freeText(result.unit, limits.maxUnitLength)) return null;
      const steps = (result.value - result.min) / result.step;
      if (Math.abs(steps - Math.round(steps)) > 1e-6) return null;
    }
    if (['input', 'textarea'].includes(kind) && (!freeText(result.value)
      || !freeText(result.placeholder, limits.maxLabelLength) || typeof result.required !== 'boolean')) return null;
    if (kind === 'date' && result.value !== '') {
      if (typeof result.value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(result.value)) return null;
      const date = new Date(result.value + 'T00:00:00Z');
      if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== result.value) return null;
    }
    if (['popover', 'pressable', 'badge'].includes(kind) && (!freeText(result.text) || !result.text.trim())) return null;
    if (kind === 'carousel') {
      const entries = array(result.items);
      if (!entries) return null;
      result.items = [];
      for (const entry of entries) {
        const item = record(entry, ['title', 'text']);
        if (!item || !text(item.title, limits.maxTitleLength) || !freeText(item.text)) return null;
        result.items.push(Object.freeze(item));
      }
      Object.freeze(result.items);
    }
    return Object.freeze(result);
  }

  // This fixed three-level shape never recursively walks or stringifies untrusted input.
  function validate(value) {
    try {
      if (!value || typeof value !== 'object') return null;
      const type = Object.getOwnPropertyDescriptor(value, 'type')?.value;
      if (typeof type !== 'string' || !Object.hasOwn(fields, type)) return null;
      const hasId = Object.hasOwn(value, 'id');
      const source = record(value, hasId && !fields[type].includes('id') ? [...fields[type], 'id'] : fields[type]);
      if (!source || (hasId && !identifier(source.id))) return null;
      if (type === 'remove') return Object.freeze(source);
      if (!text(source.title, limits.maxTitleLength)) return null;
      if (type === 'form') {
        if (!text(source.submitLabel, limits.maxLabelLength)) return null;
        const entries = array(source.controls);
        if (!entries || entries.length > limits.maxControls) return null;
        const controls = entries.map(control);
        if (controls.some(item => !item) || new Set(controls.map(item => item.id)).size !== controls.length) return null;
        return Object.freeze({ ...source, controls: Object.freeze(controls) });
      }
      if (type !== 'checklist' && !text(source.unit, limits.maxUnitLength)) return null;
      if (type === 'budget' && !isBudgetAmount(source.budget)) return null;
      const sourceItems = array(source.items);
      if (!sourceItems) return null;
      const items = [];
      for (const sourceItem of sourceItems) {
        const item = record(sourceItem, type === 'checklist' ? ['label', 'checked'] : ['label', 'value']);
        if (!item || !text(item.label, limits.maxLabelLength)) return null;
        if (type === 'checklist' ? typeof item.checked !== 'boolean'
          : !number(item.value, type === 'budget' ? limits.budgetDecimals : limits.comparisonDecimals, type === 'comparison')) return null;
        items.push(Object.freeze(type === 'checklist'
          ? { label: item.label.trim(), checked: item.checked }
          : { label: item.label.trim(), value: item.value }));
      }
      const result = { type, title: source.title.trim() };
      if (hasId) result.id = source.id;
      if (type !== 'checklist') result.unit = source.unit.trim();
      if (type === 'budget') result.budget = source.budget;
      result.items = Object.freeze(items);
      return Object.freeze(result);
    } catch (_) {
      return null;
    }
  }

  function parse(raw) {
    if (typeof raw !== 'string' || raw.length > limits.maxBlockLength) return null;
    try { return validate(JSON.parse(raw)); } catch (_) { return null; }
  }

  function calculateBudget(budget, values) {
    const amounts = array(values);
    if (!isBudgetAmount(budget) || !amounts || !amounts.every(isBudgetAmount)) return null;
    // Integer cents keep 0.1 + 0.2 and overspend comparisons exact within these bounds.
    const total = amounts.reduce((sum, amount) => sum + Math.round(amount * 100), 0);
    const remaining = Math.round(budget * 100) - total;
    return { total: total / 100, remaining: remaining / 100, overspend: Math.max(0, -remaining) / 100 };
  }

  function validateState(value) {
    if (!Array.isArray(value) || value.length > limits.maxBlocks) return null;
    const entries = value.length ? array(value) : Reflect.ownKeys(value).length === 1 ? [] : null;
    if (!entries) return null;
    const result = [];
    for (const entry of entries) {
      const spec = validate(entry);
      if (!spec || spec.type === 'remove') return null;
      result.push(spec);
    }
    return JSON.stringify(result).length <= limits.maxStateLength ? Object.freeze(result) : null;
  }

  return Object.freeze({ limits, validate, parse, validateState, isBudgetAmount, calculateBudget });
});
