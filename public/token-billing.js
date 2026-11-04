(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RaiTokenBilling = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 1e12 ? value : null;
  const money = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e9 ? value : null;
  const label = value => typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,160}$/.test(value) ? value : null;
  const round = value => Math.round(value * 1e12) / 1e12;
  // USD per million tokens, Standard tier. Preserve the rate snapshot with each estimate.
  const rates = { 'gpt-6-luna': [0.1, 0.5, 0.01, 0.125, 0.25], 'gpt-6.1-sol': [2, 10, 0.1, 2.5, 5],
    'gpt-6-astra': [10, 50, 1, 12.5, 25], 'gpt-6.1-terra': [1, 5, 0.05, 1.25, 2.5] };
  function normalize(raw = {}, options = {}) {
    if (!raw || typeof raw !== 'object') raw = {};
    const details = raw.input_tokens_details || raw.prompt_tokens_details || {};
    const writes = details.cache_write_tokens_details || {};
    const result = {
      inputTokens: count(raw.inputTokens ?? raw.prompt_tokens ?? raw.input_tokens),
      outputTokens: count(raw.outputTokens ?? raw.completion_tokens ?? raw.output_tokens),
      cacheReadTokens: count(raw.cacheReadTokens ?? raw.cachedTokens ?? raw.prompt_cache_hit_tokens ?? details.cached_tokens ?? raw.cache_read_input_tokens),
      cacheWriteTokens: count(raw.cacheWriteTokens ?? details.cache_write_tokens ?? raw.cache_write_tokens ?? raw.cache_creation_input_tokens),
      cacheWrite30mTokens: count(raw.cacheWrite30mTokens ?? writes.ttl_30m_tokens ?? raw.cache_write_30m_tokens),
      cacheWrite12hTokens: count(raw.cacheWrite12hTokens ?? writes.ttl_12h_tokens ?? raw.cache_write_12h_tokens),
      cacheWrite5mTokens: count(raw.cacheWrite5mTokens ?? raw.cache_creation?.ephemeral_5m_input_tokens),
      cacheWrite1hTokens: count(raw.cacheWrite1hTokens ?? raw.cache_creation?.ephemeral_1h_input_tokens),
      provider: label(options.provider ?? raw.provider), model: label(options.model ?? raw.model),
      serviceTier: label(options.serviceTier ?? raw.serviceTier ?? raw.service_tier) || 'default',
      cacheTtl: label(options.cacheTtl ?? raw.cacheTtl) || 'provider_default',
      actualCacheAgeSeconds: null,
      reportedCost: money(raw.reportedCost ?? raw.total_cost ?? (typeof raw.cost === 'number' ? raw.cost : raw.cost?.total)),
      reportedCurrency: typeof (raw.reportedCurrency ?? raw.currency ?? raw.cost?.currency) === 'string'
        && /^[A-Z]{3}$/.test(raw.reportedCurrency ?? raw.currency ?? raw.cost?.currency) ? (raw.reportedCurrency ?? raw.currency ?? raw.cost?.currency) : null
    };
    // Anthropic's input_tokens excludes cache reads/writes; Chat/Responses totals include them.
    if (raw.prompt_tokens === undefined && raw.inputTokens === undefined && (raw.cache_read_input_tokens !== undefined || raw.cache_creation_input_tokens !== undefined))
      result.inputTokens = result.inputTokens !== null && result.cacheReadTokens !== null && result.cacheWriteTokens !== null
        ? result.inputTokens + result.cacheReadTokens + result.cacheWriteTokens : null;
    if (result.cacheWriteTokens === null && result.cacheWrite30mTokens !== null && result.cacheWrite12hTokens !== null)
      result.cacheWriteTokens = result.cacheWrite30mTokens + result.cacheWrite12hTokens;
    for (const key of ['cacheReadTokens', 'cacheWriteTokens'])
      if (result.inputTokens !== null && result[key] > result.inputTokens) result[key] = null;
    if (result.cacheReadTokens !== null && result.cacheWriteTokens !== null && result.inputTokens !== null
      && result.cacheReadTokens + result.cacheWriteTokens > result.inputTokens) {
      result.cacheReadTokens = null; result.cacheWriteTokens = null;
    }
    if (result.cacheWrite30mTokens !== null && result.cacheWrite12hTokens !== null && result.cacheWriteTokens !== null
      && result.cacheWrite30mTokens + result.cacheWrite12hTokens !== result.cacheWriteTokens) {
      result.cacheWrite30mTokens = null; result.cacheWrite12hTokens = null;
    }
    result.cacheHit = result.cacheReadTokens === null ? null : result.cacheReadTokens > 0;
    result.cacheHitRate = result.inputTokens > 0 && result.cacheReadTokens !== null ? result.cacheReadTokens / result.inputTokens : null;
    result.uncachedInputTokens = result.inputTokens !== null && result.cacheReadTokens !== null && result.cacheWriteTokens !== null
      ? result.inputTokens - result.cacheReadTokens - result.cacheWriteTokens : null;
    result.requestedRetentionSeconds = result.provider === 'openai_official'
      ? ({ '30m': 1800, '12h': 43200, '24h': 86400 })[result.cacheTtl] ?? null : null;
    result.estimatedUsd = null; result.pricing = null;
    const prices = result.provider === 'openai_official' && ['default', 'standard'].includes(result.serviceTier) ? rates[result.model] : null;
    if (prices) {
      result.pricing = { currency: 'USD', perTokens: 1000000, source: 'https://developers.openai.com/api/docs/pricing',
        asOf: '2026-11-04', input: prices[0], output: prices[1], cacheRead: prices[2], cacheWrite30m: prices[3], cacheWrite12h: prices[4] };
      result.costsUsd = {
        input: result.uncachedInputTokens === null ? null : round(result.uncachedInputTokens * prices[0] / 1e6),
        output: result.outputTokens === null ? null : round(result.outputTokens * prices[1] / 1e6),
        cacheRead: result.cacheReadTokens === null ? null : round(result.cacheReadTokens * prices[2] / 1e6),
        cacheWrite30m: result.cacheWrite30mTokens === null ? null : round(result.cacheWrite30mTokens * prices[3] / 1e6),
        cacheWrite12h: result.cacheWrite12hTokens === null ? null : round(result.cacheWrite12hTokens * prices[4] / 1e6)
      };
      // An explicit zero total makes missing per-lifetime zero counts unambiguous.
      if (result.cacheWriteTokens === 0) result.costsUsd.cacheWrite30m = result.costsUsd.cacheWrite12h = 0;
      const costs = Object.values(result.costsUsd);
      if (costs.every(value => value !== null)) result.estimatedUsd = round(costs.reduce((sum, value) => sum + value, 0));
    }
    return result;
  }
  return Object.freeze({ normalize });
});
