"use strict";
const crypto = require('crypto');
const random = () => crypto.randomBytes(32).toString('base64url');
const digest = value => crypto.createHash('sha256').update(String(value || '')).digest();
const equal = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));
class QrError extends Error { constructor(code, statusCode = 400) { super(code); this.code = code; this.statusCode = statusCode; } }
// A QR is a short-lived invitation, never a login token. The separate owner secret
// never appears in the image, URL, logs or the approving device's response.
function createQrLoginStore({ now = Date.now, maxEntries = 1000 } = {}) {
  const entries = new Map();
  function prune() { for (const [id, r] of entries) if (r.expiresAt <= now()) entries.delete(id); }
  function get(id) { prune(); const r = entries.get(String(id)); if (!r) throw new QrError('qr_expired', 410); return r; }
  function owned(id, secret) { const r = get(id); if (!equal(r.owner, secret)) throw new QrError('qr_not_found', 404); return r; }
  function view(r) {
    const time = now();
    if (r.status === 'pending' && time >= r.qrExpiresAt) { r.scan = random(); r.qrExpiresAt = time + 3000; }
    return { id: r.id, status: r.status, code: r.code, expiresAt: r.expiresAt,
      scanToken: r.status === 'pending' ? r.scan : undefined, qrExpiresAt: r.qrExpiresAt,
      rotateAfterMs: Math.max(0, r.qrExpiresAt - time), device: r.device };
  }
  return {
    create(device) {
      prune(); if (entries.size >= maxEntries) throw new QrError('qr_busy', 429);
      const r = { id: random(), owner: random(), scan: '', qrExpiresAt: 0, expiresAt: now() + 120000,
        status: 'pending', code: String(crypto.randomInt(100000, 1000000)), device };
      entries.set(r.id, r); return { ...view(r), ownerSecret: r.owner };
    },
    poll(id, secret) { return view(owned(id, secret)); },
    claim(id, scanToken, userId, sessionId) {
      const r = get(id);
      if (r.status !== 'pending' || now() >= r.qrExpiresAt || !equal(r.scan, scanToken)) throw new QrError('qr_scan_expired', 410);
      r.status = 'scanned'; r.userId = userId; r.sessionId = sessionId; r.approval = random(); r.scan = '';
      r.expiresAt = Math.min(r.expiresAt, now() + 60000);
      return { id: r.id, code: r.code, device: r.device, approvalSecret: r.approval, expiresAt: r.expiresAt };
    },
    decide(id, proof, userId, sessionId, approve) {
      const r = get(id);
      if (r.status !== 'scanned' || r.userId !== userId || r.sessionId !== sessionId || !equal(r.approval, proof)) throw new QrError('qr_invalid_confirmation', 403);
      r.status = approve === true ? 'approved' : 'denied'; r.approval = '';
      return { status: r.status };
    },
    consume(id, secret) {
      const r = owned(id, secret); if (r.status !== 'approved') throw new QrError('qr_not_approved', 409);
      entries.delete(r.id); return { userId: r.userId, sessionId: r.sessionId };
    },
    cancel(id, secret) { owned(id, secret); entries.delete(String(id)); }
  };
}
module.exports = { createQrLoginStore, QrError };
