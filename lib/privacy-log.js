'use strict';

const crypto = require('crypto');

const SAFE_REPORT_OBJECT_KEYS = new Set([
  'attempt',
  'bytes',
  'cause',
  'code',
  'count',
  'durationMs',
  'enabled',
  'errorCode',
  'errorName',
  'fieldCount',
  'firstVisibleMs',
  'formulaCount',
  'httpStatus',
  'index',
  'length',
  'fallbackCount',
  'max',
  'method',
  'mode',
  'model',
  'modelId',
  'provider',
  'purpose',
  'responseHeadersMs',
  'requestId',
  'selectedLength',
  'contextLength',
  'stage',
  'status',
  'statusCode',
  'success',
  'timeoutMs',
  'totalMs',
  'visibleChars',
  'tool',
  'toolName',
  'type',
  'userId'
]);
const SAFE_LABEL = /^[\p{L}\p{N}_.:-]{1,80}$/u;
const SAFE_FINGERPRINT_LABEL = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const SECRET_KEY = /key|token|secret|password|authorization|cookie|credential/i;

function normalizeSecret(secret) {
  let value = String(secret || '').trim();
  if (
    value.length >= 2
    && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1).trim();
  }
  return value;
}

function derivePrivateDiagnosticsKey(secret) {
  const normalized = normalizeSecret(secret);
  if (Buffer.byteLength(normalized, 'utf8') < 32) return crypto.randomBytes(32);
  return Buffer.from(crypto.hkdfSync(
    'sha256',
    Buffer.from(normalized, 'utf8'),
    Buffer.from('rai-private-diagnostics-salt-v1', 'utf8'),
    Buffer.from('rai-private-diagnostics-hmac-v1', 'utf8'),
    32
  ));
}

function countCodePoints(value) {
  let count = 0;
  for (const _character of value) count += 1;
  return count;
}

function safePrimitiveString(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) {
    try {
      return String(value.message || value.name || 'Error');
    } catch (_) {
      return 'Error';
    }
  }
  if (value === null || value === undefined) return String(value ?? '');
  if (['number', 'boolean', 'bigint', 'symbol'].includes(typeof value)) return String(value);
  return Object.prototype.toString.call(value);
}

function createPrivacyLog(options = {}) {
  const hmacKey = derivePrivateDiagnosticsKey(options.secret);

  function privateStringMeta(value, label = 'value') {
    const raw = safePrimitiveString(value);
    const safeLabel = SAFE_FINGERPRINT_LABEL.test(String(label || '')) ? String(label) : 'value';
    return {
      redacted: true,
      type: typeof value === 'string' ? 'string' : typeof value,
      length: countCodePoints(raw),
      bytes: Buffer.byteLength(raw, 'utf8'),
      hmacSha256: crypto.createHmac('sha256', hmacKey)
        .update('v1\0', 'utf8')
        .update(safeLabel, 'utf8')
        .update('\0', 'utf8')
        .update(raw, 'utf8')
        .digest('hex')
        .slice(0, 32)
    };
  }

  function buildPrivateLogFingerprint(value, label = 'text') {
    const summary = privateStringMeta(value, label);
    return {
      length: summary.length,
      bytes: summary.bytes,
      hmacSha256: summary.hmacSha256
    };
  }

  function formatPrivateLogFingerprint(value, label = 'text') {
    const safeLabel = SAFE_FINGERPRINT_LABEL.test(String(label || '')) ? String(label) : 'text';
    const fingerprint = buildPrivateLogFingerprint(value, safeLabel);
    return `${safeLabel}Hmac=${fingerprint.hmacSha256}, ${safeLabel}Length=${fingerprint.length}, ${safeLabel}Bytes=${fingerprint.bytes}`;
  }

  function safeOwnDescriptors(value) {
    try {
      return Object.getOwnPropertyDescriptors(value);
    } catch (_) {
      return null;
    }
  }

  function safeErrorMetadata(error) {
    const descriptors = safeOwnDescriptors(error) || {};
    const name = descriptors.name?.value || 'Error';
    const code = descriptors.code?.value;
    const status = descriptors.status?.value ?? descriptors.statusCode?.value;
    const message = descriptors.message?.value || '';
    const output = Object.create(null);
    output.type = 'error';
    output.name = privateStringMeta(name, 'errorName');
    if (code !== undefined && code !== null) output.code = privateStringMeta(code, 'errorCode');
    if (Number.isFinite(Number(status))) output.status = Number(status);
    output.message = privateStringMeta(message, 'errorMessage');
    return output;
  }

  function sanitize(value, depth, fieldName, seen) {
    if (depth > 4) return '[truncated]';
    if (value === null || value === undefined) return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      return privateStringMeta(value, fieldName || 'value');
    }
    if (['bigint', 'symbol', 'function'].includes(typeof value)) {
      return privateStringMeta(value, fieldName || 'value');
    }
    let isError = false;
    try {
      isError = value instanceof Error;
    } catch (_) {
      return { redacted: true, type: 'object', unreadable: true };
    }
    if (isError) return safeErrorMetadata(value);
    if (seen.has(value)) return '[circular]';
    seen.add(value);

    let isArray = false;
    try {
      isArray = Array.isArray(value);
    } catch (_) {
      return { redacted: true, type: 'object', unreadable: true };
    }
    if (isArray) {
      const descriptors = safeOwnDescriptors(value);
      if (!descriptors) return { redacted: true, type: 'array', unreadable: true };
      const output = [];
      const length = Math.min(Number(descriptors.length?.value) || 0, 20);
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[index];
        output.push(
          descriptor && Object.hasOwn(descriptor, 'value')
            ? sanitize(descriptor.value, depth + 1, '', seen)
            : '[unreadable]'
        );
      }
      return output;
    }

    const descriptors = safeOwnDescriptors(value);
    if (!descriptors) {
      return {
        redacted: true,
        type: 'object',
        unreadable: true
      };
    }
    const output = Object.create(null);
    let index = 0;
    for (const [rawKey, descriptor] of Object.entries(descriptors).slice(0, 40)) {
      index += 1;
      const knownKey = SAFE_REPORT_OBJECT_KEYS.has(rawKey);
      const key = knownKey ? rawKey : `field_${index}`;
      if (SECRET_KEY.test(rawKey)) {
        output[key] = '[redacted]';
      } else if (!Object.hasOwn(descriptor, 'value')) {
        output[key] = '[accessor]';
      } else {
        output[key] = sanitize(descriptor.value, depth + 1, knownKey ? rawKey : '', seen);
      }
    }
    return output;
  }

  function sanitizeReportContext(value) {
    return sanitize(value, 0, '', new WeakSet());
  }

  return {
    buildPrivateLogFingerprint,
    formatPrivateLogFingerprint,
    sanitizeReportContext,
    summarizePrivateValue(value, label = 'message') {
      return privateStringMeta(value, label);
    }
  };
}

function sanitizeReportLabel(value, fallback) {
  const text = String(value || '').trim();
  return SAFE_LABEL.test(text) ? text : fallback;
}

const defaultPrivacyLog = createPrivacyLog({ secret: process.env.JWT_SECRET });

module.exports = {
  ...defaultPrivacyLog,
  createPrivacyLog,
  derivePrivateDiagnosticsKey,
  sanitizeReportLabel
};
