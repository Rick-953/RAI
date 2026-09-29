"use strict";
// A late QR response must never replace the currently selected login cookie.
// Browser QR cookies have per-session names; only an accepted access token
// selects one during refresh. Neither an unselected cookie nor its name logs in.
const { buildRefreshCookie, buildClearRefreshCookie, readRefreshTokenCookie, parseRefreshToken } = require('./auth-session-store');
const SID = /^[A-Za-z0-9_-]{32}$/;
function qrCookieName(sessionId) {
  if (!SID.test(String(sessionId || ''))) throw new TypeError('invalid_qr_refresh_scope');
  return `rai_qr_refresh_${sessionId}`;
}
function selectedRefreshToken(store, cookieHeader, scope) {
  if (scope === undefined) return store.readRefreshTokenCookie(cookieHeader);
  const token = readRefreshTokenCookie(cookieHeader, qrCookieName(scope));
  if (!token || parseRefreshToken(token)?.sessionId !== scope) return null;
  return token;
}
function cookieOptions(cookie) {
  return { production: cookie.options.secure, path: cookie.options.path, sameSite: cookie.options.sameSite,
    ttlSeconds: cookie.options.maxAge > 0 ? cookie.options.maxAge : 1 };
}
function sessionRefreshCookie(session, scope) {
  if (scope === undefined) return session.refreshCookie;
  const name = qrCookieName(scope);
  if (session.sessionId !== scope) throw new TypeError('qr_refresh_scope_mismatch');
  return buildRefreshCookie(session.refreshCookie.value, { ...cookieOptions(session.refreshCookie), name });
}
function clearSelectedRefreshCookie(store, scope) {
  const cookie = store.buildClearRefreshCookie();
  if (scope === undefined) return cookie;
  return buildClearRefreshCookie({ ...cookieOptions(cookie), name: qrCookieName(scope) });
}
module.exports = { qrCookieName, selectedRefreshToken, sessionRefreshCookie, clearSelectedRefreshCookie };
