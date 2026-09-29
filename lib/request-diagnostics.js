"use strict";
const crypto = require('crypto');
const { sanitizeReportContext } = require('./privacy-log');
function audit(event, fields = {}) {
  const safeEvent = /^[a-z0-9_]{1,64}$/.test(event) ? event : 'diagnostic';
  console.info(JSON.stringify({ time: new Date().toISOString(), event: safeEvent, ...sanitizeReportContext(fields) }));
}
function requestDiagnostics(req, res, next) {
  const requestId = crypto.randomUUID(); const start = Date.now();
  req.diagnosticRequestId = requestId; res.setHeader('X-RAI-Diagnostic-Id', requestId);
  let finished = false;
  function complete(aborted) {
    if (finished) return; finished = true;
    // Express route pattern, never actual URL/params/query/body/cookies.
    audit(aborted ? 'http_aborted' : 'http_completed', { requestId, method: req.method,
      stage: req.route?.path || 'static', statusCode: res.statusCode, durationMs: Date.now() - start });
  }
  res.once('finish', () => complete(false)); res.once('close', () => complete(!res.writableFinished)); next();
}
module.exports = { audit, requestDiagnostics };
