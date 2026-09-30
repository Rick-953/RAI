(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = { createDiagnostics: factory };
  else root.RaiDiagnostics = factory(root);
})(typeof window === 'object' ? window : globalThis, function createDiagnostics(env) {
  'use strict';
  const schema = 'rai.diagnostics.v1', version = '20260930-gpt61luna-qr-cache-r9', storageSlot = 'rai_diagnostics_v1';
  const cap = 500, responses = new WeakMap();
  const models = new Set(['auto','fast','thinking','research','custom','deepseek-flash','gpt-6.1-sol','gpt-6-luna','claude-sonnet-5','gemini-3.6-flash-low','gemini-3-flash','gemma','qwen3.6-35b-a3b','kimi-k2.6','chatgpt-gpt-oss-120b','nemotron-3-ultra','kolors-free','gpt-image-2']);
  const labels = new Set(['http','stream','app','started','headers','completed','cancelled','error','incomplete','other','GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS','chat','auth','files','sessions','user','shares','qr-login']);
  const numbers = ['seq','count','status','durationMs','events','contentChars','reasoningChars','toolEvents','firstContentMs','firstReasoningMs','inputTokens','outputTokens','cachedTokens','skippedEvents'];
  const id = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value) ? value.toLowerCase() : null;
  const chatId = value => typeof value === 'string' && /^req_[0-9]{13}_[a-f0-9]{16}$/.test(value) ? value : null;
  const label = value => labels.has(value) ? value : 'other';
  const model = value => models.has(value) ? value : 'other';
  const now = () => env.performance?.now?.() ?? Date.now();
  let records = [], seq = 0, dropped = 0, saveTimer = null;
  function sanitize(record) {
    if (!record || typeof record !== 'object' || typeof record.time !== 'string' || !Number.isFinite(Date.parse(record.time))) return null;
    const safe = { time: new Date(record.time).toISOString(), category: label(record.category), action: label(record.action), method: label(record.method), endpoint: label(record.endpoint), model: model(record.model) };
    for (const key of ['operationId','clientRequestId','serverRequestId']) safe[key] = id(record[key]);
    safe.chatRequestId = chatId(record.chatRequestId);
    for (const key of numbers) if (Number.isSafeInteger(record[key]) && Math.abs(record[key]) <= 1e12) safe[key] = record[key];
    return safe;
  }
  try {
    const saved = env.sessionStorage?.getItem(storageSlot);
    if (saved && saved.length <= 500000) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed)) records = parsed.slice(-cap).map(sanitize).filter(Boolean);
      seq = records.reduce((max, record) => Math.max(max, record.seq || 0), 0);
    }
  } catch (_) { /* Storage is optional; no logging failure may break a request. */ }
  function persist() {
    saveTimer = null;
    try { env.sessionStorage?.setItem(storageSlot, JSON.stringify(records)); } catch (_) { }
  }
  function write(category, action, fields = {}) {
    try {
      const record = sanitize({ ...fields, category, action, time: new Date().toISOString(), seq: ++seq });
      if (!record) return;
      records.push(record); if (records.length > cap) { records.shift(); dropped++; }
      if (saveTimer === null && env.setTimeout) saveTimer = env.setTimeout(persist, 1000);
    } catch (_) { dropped++; }
  }
  function uuid() {
    if (typeof env.crypto?.randomUUID === 'function') return env.crypto.randomUUID();
    const bytes = env.crypto.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  }
  function wrapFetch(fetchImpl, getApiBase) {
    return async function diagnosticFetch(resource, init) {
      let fields, options;
      try {
        const base = new URL(getApiBase(), env.location.href);
        const url = new URL(resource instanceof env.Request ? resource.url : resource, env.location.href);
        if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname.replace(/\/$/, '') + '/')) return fetchImpl(resource, init);
        fields = { clientRequestId: uuid(), method: label(String(init?.method || (resource instanceof env.Request ? resource.method : 'GET')).toUpperCase()),
          endpoint: label(url.pathname.slice(base.pathname.replace(/\/$/, '').length + 1).split('/')[0]) };
        const headers = new env.Headers(init?.headers !== undefined ? init.headers : resource instanceof env.Request ? resource.headers : undefined);
        headers.set('X-RAI-Client-Request-Id', fields.clientRequestId);
        options = { ...init, headers };
      } catch (_) { return fetchImpl(resource, init); }
      const start = now(); write('http', 'started', fields);
      try {
        const response = await fetchImpl(resource, options);
        try {
          fields = { ...fields, serverRequestId: id(response.headers.get('X-RAI-Diagnostic-Id')), chatRequestId: chatId(response.headers.get('X-Request-ID')), model: model(response.headers.get('X-Model-Used')), status: response.status };
          responses.set(response, fields);
          write('http', 'headers', { ...fields, durationMs: Math.round(now() - start) });
        } catch (_) { /* Instrumentation must not turn a successful response into a failure. */ }
        return response; // Identity, redirect metadata and the unread stream remain intact.
      } catch (error) {
        write('http', error?.name === 'AbortError' ? 'cancelled' : 'error', { ...fields, durationMs: Math.round(now() - start) });
        throw error; // Diagnostics must never retry a side effect or change authentication handling.
      }
    };
  }
  function startStream(response) {
    return { fields: { ...(responses.get(response) || {}) }, start: now(), events: 0, contentChars: 0, reasoningChars: 0, toolEvents: 0, firstContentMs: -1, firstReasoningMs: -1, done: false, failed: false, ended: false };
  }
  function observeStream(state, event) {
    if (!state || state.ended || !event || typeof event !== 'object') return;
    state.events++;
    if (event.type === 'done') state.done = true;
    if (event.type === 'error' || event.type === 'stream_warning') state.failed = true;
    if (event.type === 'cancelled') state.cancelled = true;
    if (typeof event.model === 'string') state.fields.model = model(event.model);
    if (typeof event.type === 'string' && (event.type.startsWith('tool') || event.type === 'local_agent_tool_call')) state.toolEvents++;
    const delta = event.choices?.[0]?.delta;
    const chunk = event.content ?? event.delta ?? event.text ?? delta?.content;
    const length = typeof chunk === 'string' ? chunk.length : 0;
    if (event.type === 'content' || event.type === 'delta' || delta) { state.contentChars += length; if (length && state.firstContentMs < 0) state.firstContentMs = Math.round(now() - state.start); }
    const reason = event.reasoning_content ?? delta?.reasoning_content;
    const reasoning = typeof reason === 'string' ? reason.length : ['reasoning','thinking'].includes(event.type) ? length : 0;
    state.reasoningChars += reasoning; if (reasoning && state.firstReasoningMs < 0) state.firstReasoningMs = Math.round(now() - state.start);
    const usage = event.usage;
    if (usage && typeof usage === 'object') {
      for (const [key, value] of Object.entries({ inputTokens: usage.prompt_tokens ?? usage.input_tokens, outputTokens: usage.completion_tokens ?? usage.output_tokens, cachedTokens: usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens }))
        if (Number.isSafeInteger(value) && value >= 0 && value <= 1e12) state[key] = value;
    }
  }
  function endStream(state) {
    if (!state || state.ended) return; state.ended = true;
    const action = state.cancelled ? 'cancelled' : state.failed ? 'error' : !state.done || (!state.contentChars && state.reasoningChars) ? 'incomplete' : 'completed';
    const fields = { ...state.fields, durationMs: Math.round(now() - state.start) };
    for (const key of numbers) if (Number.isSafeInteger(state[key])) fields[key] = state[key];
    write('stream', action, fields);
  }
  function reader(response) {
    const original = response.body.getReader();
    let state, decoder;
    try { state = startStream(response); decoder = new env.TextDecoder(); } catch (_) { return original; }
    let buffer = '', discarding = false;
    function line(text) {
      if (!text.startsWith('data:')) return;
      const payload = text.slice(5).trim();
      if (!payload) return;
      if (payload === '[DONE]') { state.done = true; endStream(state); return; }
      try {
        const event = JSON.parse(payload); observeStream(state, event);
        if (['done','cancelled','error'].includes(event?.type)) endStream(state);
      } catch (_) { state.skippedEvents = (state.skippedEvents || 0) + 1; }
    }
    function observe(chunk) {
      try {
        const text = chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
        // Bound partial event memory independently of untrusted tool/content lengths.
        // This is an observer only: original bytes always reach the application's parser unchanged.
        const pieces = text.split('\n');
        for (let index = 0; index < pieces.length; index++) {
          const complete = index < pieces.length - 1;
          const piece = pieces[index] + (complete ? '\n' : '');
          if (discarding) { if (complete) discarding = false; continue; }
          if (buffer.length + piece.length > 262144) {
            buffer = ''; discarding = !complete; state.skippedEvents = (state.skippedEvents || 0) + 1; continue;
          }
          buffer += piece;
          if (complete) { line(buffer.trimEnd()); buffer = ''; }
        }
        if (chunk.done) { if (buffer) line(buffer); buffer = ''; endStream(state); }
      } catch (_) { state.skippedEvents = (state.skippedEvents || 0) + 1; }
    }
    return {
      get closed() { return original.closed; },
      async read() {
        let chunk;
        try { chunk = await original.read(); }
        catch (error) {
          state.cancelled = error?.name === 'AbortError'; state.failed = !state.cancelled;
          endStream(state); throw error;
        }
        observe(chunk); return chunk;
      },
      cancel(reason) { state.cancelled = true; endStream(state); buffer = ''; return original.cancel(reason); },
      releaseLock() { original.releaseLock(); endStream(state); buffer = ''; }
    };
  }
  function report() { persist(); return { schema, product: 'rai-web', version, generatedAt: new Date().toISOString(), dropped, privacy: 'Metadata only; no credentials, messages, file names, URLs or account identifiers. Local export; never auto-uploaded.', events: records.map(sanitize).filter(Boolean) }; }
  function bind() {
    const button = env.document?.getElementById('exportDiagnosticsButton');
    button?.addEventListener('click', () => {
      let url, link;
      try {
        const blob = new env.Blob([JSON.stringify(report(), null, 2)], { type: 'application/json' });
        url = env.URL.createObjectURL(blob); link = env.document.createElement('a');
        link.href = url; link.download = 'RAI-Web-diagnostics-' + new Date().toISOString().slice(0,10) + '.json';
        env.document.body.append(link); link.click();
      } catch (_) { env.showToast?.('诊断导出未完成，请重试。'); }
      finally {
        link?.remove();
        if (url) env.setTimeout(() => env.URL.revokeObjectURL(url), 30000);
      }
    });
    env.addEventListener?.('pagehide', persist);
  }
  if (env.document?.readyState === 'loading') env.document.addEventListener('DOMContentLoaded', bind, { once: true }); else bind();
  return Object.freeze({ wrapFetch, reader, startStream, observeStream, endStream, report, sanitize });
});
