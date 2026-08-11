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

function parseCrfSource(content) {
  const m = String(content).match(/<!--\s*source:\s*([^\r\n]+?)\s*-->/);
  return m ? m[1].trim() : null;
}
function parseCrfTitle(content) {
  const m = String(content).match(/<!--\s*title:\s*([^\r\n]+?)\s*-->/);
  return m ? m[1].trim() : '导入对话';
}
function parseCrfModel(content) {
  const m = String(content).match(/<!--\s*model:\s*([^\r\n]+?)\s*-->/);
  return m ? m[1].trim() : 'auto';
}

// ---- 解析 CRF 消息块 ----
function parseCrfMessages(content) {
  const text = String(content);
  const blocks = [];
  const re = /<!--\s*message:\s*(user|assistant)\s*-->([\s\S]*?)<!--\s*end message\s*-->/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    let body = m[2].replace(/\r\n?/g, '\n').trim();
    body = body.replace(/^##\s*(用户|AI 回复)\s*\n+/, '');
    if (body) blocks.push({ role: m[1], content: body });
  }
  return blocks;
}

// ==================== JSON 通用格式（OpenAI Chat Completions 风格）====================
// 规范化：剔除含 "crf_signature" / "crf_verify" 的行后统一 \n 算哈希（与 CRF 精神一致）
function normalizeJson(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((l) => !l.includes('"crf_signature"') && !l.includes('"crf_verify"'))
    .join('\n');
}
function hashJson(text) {
  return crypto.createHash('sha256').update(normalizeJson(text), 'utf8').digest('hex');
}

function buildSignedJson({ title, model, source, messages }) {
  const doc = { title, model, source, messages, crf_verify: VERIFY_URL };
  const unsigned = JSON.stringify(doc, null, 2);
  const hash = hashJson(unsigned);
  const { signature, ts } = signHash(hash);
  doc.crf_signature = `v1.${KEY_ID}.${signature}.${ts}`;
  return JSON.stringify(doc, null, 2);
}

const JSON_SIG_RE = /"crf_signature"\s*:\s*"v1\.([^."]+)\.([A-Za-z0-9_-]+)\.(\d+)"/;

function verifyJsonText(content) {
  const text = String(content);
  const m = text.match(JSON_SIG_RE);
  if (!m) return { status: 'unsigned', source: parseJsonField(text, 'source') };
  const [, keyId, sigB64url, ts] = m;
  const hash = hashJson(text);
  const payload = `${hash}.${ts}`;
  const pub = crypto.createPublicKey({ key: getPublicKeyPem(), format: 'pem' });
  let ok = false;
  try {
    ok = crypto.verify('sha256', Buffer.from(payload, 'utf8'), pub, rawToDer(Buffer.from(sigB64url, 'base64url')));
  } catch (e) { ok = false; }
  if (!ok) return { status: 'tampered', keyId, ts: Number(ts), hash, source: parseJsonField(text, 'source') };
  return { status: 'valid', keyId, ts: Number(ts), hash, source: parseJsonField(text, 'source') };
}

function parseJsonField(content, field) {
  try {
    const doc = JSON.parse(String(content));
    return doc && typeof doc[field] !== 'undefined' ? String(doc[field]) : null;
  } catch (e) { return null; }
}
function parseJsonMessages(content) {
  try {
    const doc = JSON.parse(String(content));
    if (!doc || !Array.isArray(doc.messages)) return [];
    return doc.messages
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .map((m) => ({ role: m.role, content: m.content }));
  } catch (e) { return []; }
}

// 自动检测：JSON 或 CRF
function detectFormat(content) {
  return String(content).trimStart().startsWith('{') ? 'json' : 'crf';
}
function verifyContentText(content) {
  return detectFormat(content) === 'json' ? verifyJsonText(content) : verifyCrfText(content);
}
function parseMessages(content) {
  return detectFormat(content) === 'json' ? parseJsonMessages(content) : parseCrfMessages(content);
}
function parseTitle(content) {
  return detectFormat(content) === 'json' ? (parseJsonField(content, 'title') || '导入对话') : parseCrfTitle(content);
}
function parseModel(content) {
  return detectFormat(content) === 'json' ? (parseJsonField(content, 'model') || 'auto') : parseCrfModel(content);
}
function parseSource(content) {
  return detectFormat(content) === 'json' ? parseJsonField(content, 'source') : parseCrfSource(content);
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
  parseCrfSource, parseCrfTitle, parseCrfModel, parseCrfMessages, buildSignedCrf,
  normalizeJson, hashJson, buildSignedJson, verifyJsonText,
  detectFormat, verifyContentText, parseMessages, parseTitle, parseModel, parseSource,
  getPublicKeyPem
};
