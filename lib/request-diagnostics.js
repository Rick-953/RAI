"use strict";
const crypto = require('crypto');
const { sanitizeReportContext } = require('./privacy-log');
const { trace } = require('./diagnostic-trace');
const EVENTS = new Set(['http_aborted','http_completed','chat_route','chat_completed','stream_reasoning_without_answer','secure_route_failed','qr_created','qr_scanned','qr_confirmed','qr_consumed','qr_cancelled','share_created','share_revoked','share_read']);
function audit(event, fields = {}, req = null) {
  const safeEvent = EVENTS.has(event) ? event : 'diagnostic';
  console.info(JSON.stringify({ time: new Date().toISOString(), event: safeEvent, ...sanitizeReportContext(fields), trace: trace(req, fields) }));
}
function requestDiagnostics(req, res, next) {
  const requestId = crypto.randomUUID(); const start = Date.now();
  req.diagnosticRequestId = requestId; res.setHeader('X-RAI-Diagnostic-Id', requestId);
  let finished = false;
  function complete(aborted) {
    if (finished) return; finished = true;
    // Express route pattern, never actual URL/params/query/body/cookies.
    audit(aborted ? 'http_aborted' : 'http_completed', { requestId, method: req.method,
      stage: req.route?.path || 'static', statusCode: res.statusCode, durationMs: Date.now() - start }, req);
  }
  res.once('finish', () => complete(false)); res.once('close', () => complete(!res.writableFinished)); next();
}
module.exports = { audit, requestDiagnostics };
