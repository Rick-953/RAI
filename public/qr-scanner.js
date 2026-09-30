/* Local-only QR decoding. Camera frames and selected images never leave this device. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RaiQrScanner = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';
  function parseLoginQr(text, apiBase, pageUrl) {
    if (typeof text !== 'string' || text.length > 2048) return null;
    try {
      const base = new URL(apiBase, pageUrl), qr = new URL(text);
      if (!['https:', 'http:'].includes(base.protocol) || !/\/api\/?$/.test(base.pathname)) return null;
      if (qr.origin !== base.origin || qr.username || qr.password || qr.search) return null;
      if (qr.pathname !== base.pathname.replace(/\/api\/?$/, '') + '/qr-login.html') return null;
      const match = /^#([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec(qr.hash);
      return match ? { id: match[1], scanToken: match[2] } : null;
    } catch (_) { return null; }
  }
  function needsCameraGesture(navigator, matchMedia) {
    const ios = /iP(hone|ad|od)/.test(navigator.userAgent || '')
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const standalone = navigator.standalone === true || !!matchMedia?.('(display-mode: standalone)').matches;
    const version = /(?:CPU (?:iPhone )?OS|iPhone OS) (\d+)[_.]/.exec(navigator.userAgent || '');
    return ios && standalone && (!version || Number(version[1]) <= 18);
  }
  function stopStream(stream) {
    if (!stream) return;
    for (const track of stream.getTracks()) { try { track.stop(); } catch (_) { /* stop the remaining tracks */ } }
  }
  class CameraScanner {
    constructor({ video, canvas, getUserMedia, decode, onResult, onError, schedule = (fn, delay) => setTimeout(fn, delay), cancel = handle => clearTimeout(handle), isActive = () => true, permissionTimeoutMs = 12000, armTimeout = (fn, delay) => setTimeout(fn, delay), clearTimeoutHandle = handle => clearTimeout(handle) }) {
      Object.assign(this, { video, canvas, getUserMedia, decode, onResult, onError, schedule, cancel, isActive, permissionTimeoutMs, armTimeout, clearTimeoutHandle });
      this.generation = 0;
      this.stream = null;
      this.timer = null;
      this.permissionTimer = null;
    }
    stop() {
      this.generation++;
      this.cancel(this.timer);
      this.clearTimeoutHandle(this.permissionTimer); this.permissionTimer = null;
      this.timer = null;
      const stream = this.stream;
      this.stream = null;
      stopStream(stream);
      try { this.video.pause(); } catch (_) { /* detached media element */ }
      this.video.srcObject = null;
    }
    async start() {
      this.stop();
      const generation = this.generation;
      if (!this.isActive()) return;
      this.permissionTimer = this.armTimeout(() => {
        if (generation !== this.generation) return;
        this.stop(); const error = new Error('camera_timeout'); error.name = 'TimeoutError'; this.onError(error);
      }, this.permissionTimeoutMs);
      try {
        const stream = await this.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 960 }, height: { ideal: 720 } } });
        // Permission can resolve after closing or starting another scanner. Never adopt a late stream.
        if (generation !== this.generation || !this.isActive()) { stopStream(stream); if (generation === this.generation) this.stop(); return; }
        this.stream = stream;
        this.video.srcObject = stream;
        await this.video.play();
        if (generation !== this.generation) return;
        if (!this.isActive()) { this.stop(); return; }
        this.clearTimeoutHandle(this.permissionTimer); this.permissionTimer = null;
        const tick = () => {
          if (generation !== this.generation) return;
          if (!this.isActive()) { this.stop(); return; }
          try {
            if (this.video.readyState >= 2 && this.video.videoWidth && this.video.videoHeight) {
              const result = this.read(this.video, this.video.videoWidth, this.video.videoHeight, 720);
              if (result && this.onResult(result.data)) { this.stop(); return; }
            }
          } catch (error) { this.stop(); this.onError(error); return; }
          this.timer = this.schedule(tick, 180);
        };
        tick();
      } catch (error) {
        if (generation !== this.generation) return;
        this.stop(); this.onError(error);
      }
    }
    read(source, width, height, maxSize = 1440) {
      if (!width || !height || width * height > 40_000_000) throw new Error('image_dimensions');
      const scale = Math.min(1, maxSize / Math.max(width, height));
      this.canvas.width = Math.max(1, Math.round(width * scale));
      this.canvas.height = Math.max(1, Math.round(height * scale));
      const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(source, 0, 0, this.canvas.width, this.canvas.height);
      const pixels = ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
      return this.decode(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'attemptBoth' });
    }
  }
  return { parseLoginQr, CameraScanner, needsCameraGesture };
});
