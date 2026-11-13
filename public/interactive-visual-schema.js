(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RAIInteractiveVisualSchema = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';

  const limits = Object.freeze({
    maxItems: 24, maxTitleLength: 120, maxLabelLength: 120, maxUnitLength: 16,
    maxValue: 1000000000, budgetDecimals: 2, comparisonDecimals: 6,
    maxBlockLength: 16384, maxBlocks: 8, maxContentLength: 1000000
  });
  const fields = {
    budget: ['type', 'title', 'unit', 'budget', 'items'],
    comparison: ['type', 'title', 'unit', 'items'],
    checklist: ['type', 'title', 'items']
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

  // This fixed three-level shape never recursively walks or stringifies untrusted input.
  function validate(value) {
    try {
      if (!value || typeof value !== 'object') return null;
      const type = Object.getOwnPropertyDescriptor(value, 'type')?.value;
      if (typeof type !== 'string' || !Object.hasOwn(fields, type)) return null;
      const source = record(value, fields[type]);
      if (!source || !text(source.title, limits.maxTitleLength)) return null;
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

  return Object.freeze({ limits, validate, parse, isBudgetAmount, calculateBudget });
});
