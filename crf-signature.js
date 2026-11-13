'use strict';
// crf-signature.js — CRF 防篡改签名库（服务端）
// 规范: CRF-FORMAT.md — ECDSA P-256 + SHA-256，载荷 "<sha256hex>.<unixTs>"
// 规范化: UTF-8 → 统一 \n → 剔除 crf-signature/crf-verify 两行 → 剩余全文 SHA-256
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const KEY_DIR = process.env.CRF_SIGN_KEY_DIR || '/opt/rai/crf-tools/keys';
const KEY_PATH = path.join(KEY_DIR, 'crf-sign-key.pem');
const PUB_PATH = path.join(KEY_DIR, 'crf-sign-pub.pem');
const KEY_ID = process.env.CRF_SIGN_KEY_ID || 'dev1';
const VERIFY_URL = process.env.CRF_VERIFY_URL || 'https://rai.rick.sarl/verify';

const SIG_RE = /<!--\s*crf-signature:\s*v1\.([^.\s]+)\.([A-Za-z0-9_-]+)\.(\d+)\s*-->/;

let cachedPrivateKey = null;
let cachedPublicKeyPem = null;

function getPrivateKey() {
  if (!cachedPrivateKey) cachedPrivateKey = crypto.createPrivateKey(fs.readFileSync(KEY_PATH));
  return cachedPrivateKey;
}
function getPublicKeyPem() {
  if (!cachedPublicKeyPem) cachedPublicKeyPem = fs.readFileSync(PUB_PATH, 'utf8');
  return cachedPublicKeyPem;
}

// ---- DER <-> raw(r||s 64B)，Windows Ecdsa256 与浏览器 WebCrypto 用 raw ----
function derToRaw(der) {
  let p = 0;
  if (der[p++] !== 0x30) throw new Error('bad der seq');
  p += 1; // seqLen < 128
  if (der[p++] !== 0x02) throw new Error('bad der r');
  let rl = der[p++]; let r = der.subarray(p, p + rl); p += rl;
  if (der[p++] !== 0x02) throw new Error('bad der s');
  let sl = der[p++]; let s = der.subarray(p, p + sl);
  if (r[0] === 0) r = r.subarray(1);
  if (s[0] === 0) s = s.subarray(1);
  const r32 = Buffer.alloc(32); r.copy(r32, 32 - r.length);
  const s32 = Buffer.alloc(32); s.copy(s32, 32 - s.length);
  return Buffer.concat([r32, s32]);
}
function rawToDer(raw) {
  function enc(x) {
    let v = x;
    while (v.length > 1 && v[0] === 0) v = v.subarray(1);
    if (v[0] & 0x80) v = Buffer.concat([Buffer.from([0]), v]);
    return Buffer.concat([Buffer.from([0x02, v.length]), v]);
  }
  const er = enc(raw.subarray(0, 32)), es = enc(raw.subarray(32));
  return Buffer.concat([Buffer.from([0x30, er.length + es.length]), er, es]);
}

// ---- 规范化 + 哈希 ----
function normalizeCrf(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((l) => !l.startsWith('<!-- crf-signature:') && !l.startsWith('<!-- crf-verify:'))
    .join('\n');
}
function hashCrf(text) {
  return crypto.createHash('sha256').update(normalizeCrf(text), 'utf8').digest('hex');
}

// ---- 签名 ----
function signHash(contentHash) {
  const ts = Math.floor(Date.now() / 1000);
  const payload = `${contentHash}.${ts}`;
  const der = crypto.sign('sha256', Buffer.from(payload, 'utf8'), getPrivateKey());
  return { signature: derToRaw(der).toString('base64url'), ts };
}

// ---- 验签（直接给完整 CRF 文本）----
function verifyCrfText(content) {
  const m = String(content).match(SIG_RE);
  if (!m) return { status: 'unsigned', source: parseSource(content) };
  const [, keyId, sigB64url, ts] = m;
  const hash = hashCrf(content);
  const payload = `${hash}.${ts}`;
  const pub = crypto.createPublicKey({ key: getPublicKeyPem(), format: 'pem' });
  let ok = false;
  try {
    ok = crypto.verify('sha256', Buffer.from(payload, 'utf8'), pub, rawToDer(Buffer.from(sigB64url, 'base64url')));
  } catch (e) {
    ok = false;
  }
  if (!ok) return { status: 'tampered', keyId, ts: Number(ts), hash, source: parseSource(content) };
  return { status: 'valid', keyId, ts: Number(ts), hash, source: parseSource(content) };
}

function parseCrfField(content, field, fallback) {
  const text = String(content);
  // field is an internal constant: source/title/model, never user-controlled.
  const header = new RegExp('<!--\\s*' + field + ':', 'g');
  const lineBreak = /[\r\n]/g;
  let close = -1;
  let trimmedClose = -1;
  let nextLineBreak = -1;
  let match;
  while ((match = header.exec(text)) !== null) {
    let start = header.lastIndex;
    let whitespaceCanCapture = false;
    while (start < text.length && /\s/.test(text[start])) {
      if (text[start] !== '\r' && text[start] !== '\n') whitespaceCanCapture = true;
      start++;
    }
    if (close < start + 1) {
      close = text.indexOf('-->', start + 1);
      if (close === -1) {
        if (whitespaceCanCapture && text.startsWith('-->', start)) return '';
        return fallback;
      }
      trimmedClose = close;
      while (trimmedClose > 0 && /\s/.test(text[trimmedClose - 1])) trimmedClose--;
    }

    if (nextLineBreak < start) {
      lineBreak.lastIndex = start;
      const found = lineBreak.exec(text);
      nextLineBreak = found ? found.index : text.length;
    }
    if (nextLineBreak < trimmedClose) {
      if (whitespaceCanCapture && text.startsWith('-->', start)) return '';
      continue;
    }
    return text.slice(start, trimmedClose).trim();
  }
  return fallback;
}
function parseSource(content) { return parseCrfField(content, 'source', null); }
function parseTitle(content) { return parseCrfField(content, 'title', '导入对话'); }
function parseModel(content) { return parseCrfField(content, 'model', 'auto'); }

function parseCrfMessages(content) {
  const text = String(content);
  const marker = /<!--\s*(?:message:\s*(user|assistant)|end message)\s*-->/g;
  const blocks = [];
  let pending = null;
  let match;
  while ((match = marker.exec(text)) !== null) {
    if (match[1]) {
      // Legacy parser keeps the earliest opener until the first end marker;
      // nested openers remain literal body text.
      if (!pending) pending = { role: match[1], start: marker.lastIndex };
    } else if (pending) {
      let body = text.slice(pending.start, match.index).replace(/\r\n?/g, '\n').trim();
      body = body.replace(/^##\s*(用户|AI 回复)\s*\n+/, '');
      if (body) blocks.push({ role: pending.role, content: body });
      pending = null;
    }
  }
  return blocks;
}

// ---- 组装带签名行的 CRF 文本 ----
function buildSignedCrf({ title, model, source, messages }) {
  const lines = [
    '<!-- CX RAI CRF v1 -->',
    `<!-- title: ${title} -->`,
    `<!-- model: ${model} -->`,
    `<!-- source: ${source} -->`,
    `<!-- crf-verify: ${VERIFY_URL} -->`,
    ''
  ];
  for (const msg of messages) {
    const heading = msg.role === 'assistant' ? 'AI 回复' : '用户';
    lines.push(`<!-- message: ${msg.role} -->`, `## ${heading}`, '', String(msg.content || '').trim(), '<!-- end message -->', '');
  }
  const unsigned = lines.join('\n');
  const hash = hashCrf(unsigned);
  const { signature, ts } = signHash(hash);
  const sigLine = `<!-- crf-signature: v1.${KEY_ID}.${signature}.${ts} -->`;
  // 插到 source 行之后（即 verify 行之前）
  const parts = unsigned.split('\n');
  const idx = parts.findIndex((l) => l.startsWith('<!-- source:'));
  parts.splice(idx + 1, 0, sigLine);
  return parts.join('\n');
}

module.exports = {
  KEY_ID, VERIFY_URL,
  normalizeCrf, hashCrf, signHash, verifyCrfText,
  parseSource, parseTitle, parseModel, parseCrfMessages, buildSignedCrf,
  getPublicKeyPem
};
