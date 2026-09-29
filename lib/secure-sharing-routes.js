"use strict";
const crypto = require('crypto');
const QRCode = require('qrcode');
const rateLimit = require('express-rate-limit');
const { createQrLoginStore } = require('./qr-login');
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const validKey = value => /^[A-Za-z0-9_-]{43}$/.test(String(value || ''));
function installSecureSharingRoutes({ app, authenticateToken, authLimiter, apiLimiter, dbRunAsync, dbGetAsync, dbAllAsync, withMainDbTransaction,
  buildAuthenticatedUserPayload, buildAuthSessionDeviceMetadata, authSessionStartupReady, allowedCorsOrigins, publicBaseUrl = '', audit }) {
  if (typeof withMainDbTransaction !== 'function') throw new TypeError('share_transaction_required');
  // Local guards remain effective even when this module is installed by another
  // host. Keep polling separate from auth/mutations so normal 3s refresh is cheap.
  const qrCreateLimiter = rateLimit({ windowMs: 60000, max: 12, standardHeaders: true, legacyHeaders: false, message: { error: 'qr_create_rate_limited' } });
  const qrPollLimiter = rateLimit({ windowMs: 60000, max: 120, standardHeaders: true, legacyHeaders: false, message: { error: 'qr_poll_rate_limited' } });
  const secureMutationLimiter = rateLimit({ windowMs: 60000, max: 60, standardHeaders: true, legacyHeaders: false, message: { error: 'secure_action_rate_limited' } });
  const shareReadLimiter = rateLimit({ windowMs: 60000, max: 120, standardHeaders: true, legacyHeaders: false, message: { error: 'share_read_rate_limited' } });
  const qr = createQrLoginStore();
  const configuredUrl = publicBaseUrl ? new URL(publicBaseUrl) : null;
  const basePath = configuredUrl ? configuredUrl.pathname.replace(/\/+$/, '') : '';
  app.use(['/api/auth/qr', '/api/shares', '/api/sessions/:id/share'], (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer'); next();
  });
  const ready = authSessionStartupReady.then(() => dbRunAsync(`CREATE TABLE IF NOT EXISTS conversation_shares (
    id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL, session_id TEXT NOT NULL,
    snapshot TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL)`));
  const wrap = fn => async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
    try { await ready; await fn(req, res); }
    catch (error) { audit('secure_route_failed', { code: error.code || 'internal_error', statusCode: error.statusCode || 500 });
      if (!res.headersSent) res.status(error.statusCode || 500).json({ error: error.statusCode ? error.code : 'request_failed' }); }
  };
  const fail = (code, statusCode) => { throw Object.assign(new Error(code), { code, statusCode }); };
  // Owner secret is sent in POST JSON, not query strings or referrers.
  async function renderState(state) {
    if (state.scanToken) {
      const data = `${basePath}/qr-login.html#${state.id}.${state.scanToken}`;
      // Relative QR payload is resolved by clients against their configured trusted origin.
      state.scanPath = data;
      delete state.scanToken;
    }
    return state;
  }
  app.post('/api/auth/qr/create', qrCreateLimiter, authLimiter, wrap(async (req, res) => {
    const m = buildAuthSessionDeviceMetadata(req);
    const device = [m.osName, m.browserName].filter(Boolean).join(' / ').slice(0, 100);
    audit('qr_created', {}); res.json(await renderState(qr.create(device)));
  }));
  // Fast polling must not use the password-login limiter (3-second refresh is normal).
  app.post('/api/auth/qr/poll', qrPollLimiter, apiLimiter, wrap(async (req, res) => res.json(await renderState(qr.poll(req.body.id, req.body.ownerSecret)))));
  app.post('/api/auth/qr/image', qrPollLimiter, apiLimiter, wrap(async (req, res) => {
    const state = qr.poll(req.body.id, req.body.ownerSecret);
    if (!state.scanToken) return res.json(await renderState(state));
    // Do not accept an arbitrary origin from the caller: it could turn QR login into phishing.
    const origin = 'https://' + req.get('host');
    if (!allowedCorsOrigins.has(origin)) fail('qr_origin_not_allowed', 403);
    const image = await QRCode.toDataURL(`${origin}${basePath}/qr-login.html#${state.id}.${state.scanToken}`, { width: 280, margin: 2, errorCorrectionLevel: 'M' });
    res.json({ ...await renderState(state), image });
  }));
  app.post('/api/auth/qr/claim', secureMutationLimiter, apiLimiter, authenticateToken, wrap(async (req, res) => {
    res.json(qr.claim(req.body.id, req.body.scanToken, req.user.userId, req.user.sid, req.user.sv)); audit('qr_scanned', {});
  }));
  app.post('/api/auth/qr/confirm', secureMutationLimiter, apiLimiter, authenticateToken, wrap(async (req, res) => {
    res.json(qr.decide(req.body.id, req.body.approvalSecret, req.user.userId, req.user.sid, req.body.approve)); audit('qr_confirmed', { success: req.body.approve === true });
  }));
  app.post('/api/auth/qr/cancel', secureMutationLimiter, apiLimiter, wrap(async (req, res) => { qr.cancel(req.body.id, req.body.ownerSecret); res.json({ success: true }); }));
  app.post('/api/auth/qr/consume', secureMutationLimiter, authLimiter, wrap(async (req, res) => {
    const grant = qr.consume(req.body.id, req.body.ownerSecret);
    // Session validity is rechecked atomically by createSession during issuance.
    const user = await dbGetAsync('SELECT * FROM users WHERE id = ?', [grant.userId]);
    if (!user || Number(user.email_verified ?? 1) !== 1) fail('qr_account_unavailable', 403);
    res.json(await buildAuthenticatedUserPayload(user, req, '', { auth_method: req.body.browserSession === true ? 'qr_browser' : 'qr' }, { authorizedBySession: { sessionId: grant.sessionId, sessionVersion: grant.sessionVersion } })); audit('qr_consumed', {});
  }));
  app.post('/api/sessions/:id/share', secureMutationLimiter, apiLimiter, authenticateToken, wrap(async (req, res) => {
    const key = crypto.randomBytes(32).toString('base64url'); const expiresAt = Date.now() + 7 * 86400000;
    // Rotation is atomic: concurrent creations cannot leave multiple active links,
    // and a failed insert must not revoke the previously working snapshot.
    const count = await withMainDbTransaction(async tx => {
      const session = await tx.get('SELECT id, title FROM sessions WHERE id = ? AND user_id = ?', [req.params.id, req.user.userId]);
      if (!session) fail('session_not_found', 404);
      const messages = await tx.all("SELECT role, content FROM messages WHERE session_id = ? AND role IN ('user', 'assistant') ORDER BY created_at, id LIMIT 500", [session.id]);
      // Explicit plain-text snapshot only: no system prompts, reasoning, tool traces or attachment URLs.
      const clean = messages.map(m => ({ role: m.role, content: String(m.content || '').replace(/!\[[^\]]*\]\([^)]*\)/g, '[图片未分享]').replace(/\]\((?:https?:\/\/[^/\s)]+)?\/(?:api|uploads|avatars)\/[^)]*\)/gi, '](附件未分享)') }));
      const snapshot = JSON.stringify({ title: String(session.title || 'RAI 对话'), messages: clean });
      if (Buffer.byteLength(snapshot) > 1024 * 1024) fail('share_too_large', 413);
      await tx.run('DELETE FROM conversation_shares WHERE expires_at <= ? OR (owner_id = ? AND session_id = ?)', [Date.now(), req.user.userId, session.id]);
      await tx.run('INSERT INTO conversation_shares VALUES (?, ?, ?, ?, ?, ?)', [hash(key), req.user.userId, session.id, snapshot, expiresAt, Date.now()]);
      return clean.length;
    });
    res.json({ sharePath: `${basePath}/share.html#${key}`, key, expiresAt }); audit('share_created', { count });
  }));
  app.delete('/api/sessions/:id/share', secureMutationLimiter, apiLimiter, authenticateToken, wrap(async (req, res) => {
    await withMainDbTransaction(tx => tx.run('DELETE FROM conversation_shares WHERE owner_id = ? AND session_id = ?', [req.user.userId, req.params.id]));
    res.json({ success: true }); audit('share_revoked', {});
  }));
  app.post('/api/shares/read', shareReadLimiter, apiLimiter, wrap(async (req, res) => {
    if (!validKey(req.body.key)) fail('share_not_found', 404);
    const row = await dbGetAsync(`SELECT snapshot FROM conversation_shares WHERE id = ? AND expires_at > ?
      AND EXISTS (SELECT 1 FROM sessions WHERE sessions.id = conversation_shares.session_id AND sessions.user_id = conversation_shares.owner_id)`, [hash(req.body.key), Date.now()]);
    if (!row) fail('share_not_found', 404);
    res.json(JSON.parse(row.snapshot)); audit('share_read', {});
  }));
}
module.exports = { installSecureSharingRoutes };
