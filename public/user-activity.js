(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.RaiUserActivity = factory(root);
})(typeof window === 'object' ? window : globalThis, function createUserActivity(env) {
  'use strict';
  const rawFetch = env.fetch.bind(env), runId = env.crypto.randomUUID();
  const label = value => typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,160}$/.test(value) ? value : null;
  let getContext = () => ({}), queue = [], owner = '', seq = 0, dropped = 0, timer = null, sending = false;
  const responses = new WeakMap();
  const slot = account => 'rai_server_activity_v1:' + account;
  function persist() {
    try { if (owner) env.localStorage?.setItem(slot(owner), JSON.stringify(queue)); } catch (_) { }
  }
  function context() {
    let value;
    try { value = getContext() || {}; } catch (_) { owner = ''; queue = []; return {}; }
    const account = value.token && value.account ? value.apiBase + '|' + value.account : '';
    if (owner !== account) {
      persist(); queue = []; owner = account; dropped = 0;
      try {
        const saved = account && env.localStorage?.getItem(slot(account));
        if (saved && saved.length <= 2 * 1024 * 1024) queue = JSON.parse(saved).filter(item => item && typeof item.id === 'string' && typeof item.timeMs === 'number').slice(-500);
      } catch (_) { queue = []; }
    }
    return value;
  }
  function record(kind, action, fields = {}, expectedOwner = null) {
    try {
      const value = context();
      if (expectedOwner && owner !== expectedOwner) return;
      if (!owner || !label(action)) return;
      const event = { ...fields, id: env.crypto.randomUUID(), runId, seq: ++seq, timeMs: Date.now(), kind, action,
        sessionId: fields.sessionId ?? value.sessionId ?? null, context: { ...value.environment, ...fields.context },
        metrics: { ...fields.metrics, dropped } };
      if (queue.length >= 500) { queue.shift(); dropped++; }
      queue.push(event);
      if (kind === 'error') persist();
      if (timer === null) timer = env.setTimeout(() => { timer = null; void flush(); }, 2000);
    } catch (_) { /* Telemetry cannot break the UI. */ }
  }
  async function flush() {
    const value = context();
    if (sending || !queue.length || !owner) return;
    const capturedOwner = owner, batch = queue.slice(0, 50);
    persist();
    sending = true;
    try {
      const body = JSON.stringify({ source: 'web', events: batch });
      const response = await rawFetch(value.apiBase + '/user/activity', { method: 'POST', keepalive: body.length < 60000,
        headers: { Authorization: 'Bearer ' + value.token, 'Content-Type': 'application/json' },
        body });
      if (owner === capturedOwner && (response.ok || [400,403,413].includes(response.status))) {
        const ids = new Set(batch.map(item => item.id));
        queue = queue.filter(item => !ids.has(item.id));
        persist();
        if (!response.ok) dropped += batch.length;
      }
    } catch (_) { /* Keep bounded events until the connection returns. */ }
    finally {
      sending = false;
      if (queue.length && owner === capturedOwner && timer === null) timer = env.setTimeout(() => { timer = null; void flush(); }, 10000);
    }
  }
  function configure(provider) { getContext = provider; }
  function wrapFetch(fetchImpl) {
    return async function activityFetch(resource, init) {
      const value = context();
      let options = init, requestId, sessionId;
      try {
        const base = new URL(value.apiBase, env.location.href), url = new URL(resource instanceof env.Request ? resource.url : resource, env.location.href);
        if (!owner || url.origin !== base.origin || !url.pathname.startsWith(base.pathname + '/') || url.pathname.endsWith('/user/activity')) return fetchImpl(resource, init);
        const headers = new env.Headers(init?.headers !== undefined ? init.headers : resource instanceof env.Request ? resource.headers : undefined);
        requestId = headers.get('X-RAI-Client-Request-Id') || env.crypto.randomUUID();
        headers.set('X-RAI-Client-Request-Id', requestId);
        headers.set('X-RAI-Client-Context', env.btoa(JSON.stringify(value.environment)));
        options = { ...init, headers };
        sessionId = value.sessionId;
      } catch (_) { return fetchImpl(resource, init); }
      const started = Date.now();
      const requestOwner = owner;
      record('http', 'started', { clientRequestId: requestId, sessionId }, requestOwner);
      try {
        const response = await fetchImpl(resource, options);
        const fields = { clientRequestId: requestId, sessionId, activityOwner: requestOwner, serverRequestId: response.headers.get('X-RAI-Diagnostic-Id'),
          chatRequestId: response.headers.get('X-Request-ID'), metrics: { status: response.status, durationMs: Date.now() - started } };
        responses.set(response, fields);
        record(response.ok ? 'http' : 'error', 'headers', fields, requestOwner);
        return response;
      } catch (error) {
        record('error', error?.name === 'AbortError' ? 'cancelled' : 'error', { clientRequestId: requestId, sessionId, errorType: label(error?.name), metrics: { durationMs: Date.now() - started } }, requestOwner);
        throw error;
      }
    };
  }
  function diagnostic(recordValue) {
    if (recordValue.category !== 'stream') return;
    const metrics = {};
    for (const key of ['events','contentChars','reasoningChars','toolEvents','firstContentMs','firstReasoningMs','inputTokens','outputTokens','cachedTokens','cacheWriteTokens','durationMs']) if (Number.isSafeInteger(recordValue[key])) metrics[key] = recordValue[key];
    record(recordValue.action === 'completed' || recordValue.action === 'cancelled' ? 'stream' : 'error', recordValue.action, {
      clientRequestId: recordValue.clientRequestId, serverRequestId: recordValue.serverRequestId, chatRequestId: recordValue.chatRequestId,
      sessionId: recordValue.sessionId, stage: 'stream_end', metrics
    }, recordValue.activityOwner);
  }
  env.addEventListener?.('error', event => record('error', 'unhandled_exception', { errorType: label(event.error?.name) || 'Error', stage: 'window' }));
  env.addEventListener?.('unhandledrejection', event => record('error', 'unhandled_rejection', { errorType: label(event.reason?.name) || 'Error', stage: 'promise' }));
  env.document?.addEventListener('click', event => {
    const target = event.target?.closest?.('button,[role="button"],input[type="checkbox"],select');
    if (!target || target.closest('[data-rai-click]')) return;
    record('ui', 'control_click', { control: label(target.id) || target.tagName, stage: 'click' });
  }, true);
  env.document?.addEventListener('change', event => {
    const target = event.target;
    if (!target?.matches?.('select,input[type="checkbox"],input[type="range"]') || target.hasAttribute('data-rai-change')) return;
    record('ui','control_change',{ control:label(target.id) || target.tagName,stage:'change' });
  }, true);
  env.addEventListener?.('pagehide', () => { persist(); void flush(); });
  return Object.freeze({ configure, record, flush, wrapFetch, diagnostic, responseContext: response => responses.get(response) });
});
