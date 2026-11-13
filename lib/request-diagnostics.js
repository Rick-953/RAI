"use strict";
const crypto = require('crypto');
const { sanitizeReportContext } = require('./privacy-log');
const { trace } = require('./diagnostic-trace');
const { createChatLatencyTrace } = require('./chat-latency');
const EVENTS = new Set(['http_aborted','http_completed','chat_route','chat_completed','stream_reasoning_without_answer','secure_route_failed','qr_created','qr_scanned','qr_confirmed','qr_consumed','qr_cancelled','share_created','share_revoked','share_read']);
function audit(event, fields = {}, req = null) {
  const safeEvent = EVENTS.has(event) ? event : 'diagnostic';
  console.info(JSON.stringify({ time: new Date().toISOString(), event: safeEvent, ...sanitizeReportContext(fields), trace: trace(req, fields) }));
  if (EVENTS.has(event) && event !== 'http_completed' && event !== 'http_aborted') req?.recordUserActivity?.(event, { kind: event.includes('failed') || event.includes('without_answer') ? 'error' : 'stream' });
}
function requestDiagnostics(req, res, next) {
  const requestId = crypto.randomUUID(); const start = Date.now();
  req.diagnosticRequestId = requestId; res.setHeader('X-RAI-Diagnostic-Id', requestId);
  if (req.path === '/api/chat/stream') req.chatLatency = createChatLatencyTrace(req, res);
  let finished = false;
  function complete(aborted) {
    if (finished) return; finished = true;
    const latency = req.chatLatency?.finish(aborted);
    // chat-latency constructs only fixed enums, numeric timings and validated IDs.
    // Passing it through the generic privacy logger would hash the stage labels.
    if (latency) console.info(JSON.stringify(latency));
    req.recordUserActivity?.(aborted ? 'http_aborted' : 'http_completed', {
      stage: typeof req.route?.path === 'string' ? req.route.path : 'api',
      metrics: { status: res.statusCode, durationMs: Date.now() - start }, latency: req.chatLatency?.activity?.() || latency,
      context: { ...req.activityClientContext, selectedModel: req.body?.model, reasoningProfile: req.body?.reasoningProfile,
        thinkingMode: req.body?.thinkingMode, internetMode: req.body?.internetMode, agentMode: req.body?.client_agent_mode,
        selectedSkills: Array.isArray(req.body?.client_skills?.selected) ? req.body.client_skills.selected.map(skill => skill?.name) : req.body?.selected_skill_names,
        memoryMode: req.body?.memoryMode, researchModeName: req.body?.researchMode, thinkingBudget: req.body?.thinkingBudget }
    });
    // Express route pattern, never actual URL/params/query/body/cookies.
    audit(aborted ? 'http_aborted' : 'http_completed', { requestId, method: req.method,
      stage: req.route?.path || 'static', statusCode: res.statusCode, durationMs: Date.now() - start }, req);
  }
  res.once('finish', () => complete(false)); res.once('close', () => complete(!res.writableFinished)); next();
}
module.exports = { audit, requestDiagnostics };
