// verify.js — CRF 纯前端验签（WebCrypto ECDSA P-256）
// 规范化规则与 CRF-FORMAT.md 完全一致：UTF-8 → 统一 \n → 剔除 signature/verify 两行 → SHA-256
(function () {
  'use strict';
  var SIG_RE = /<!--\s*crf-signature:\s*v1\.([^.\s]+)\.([A-Za-z0-9_-]+)\.(\d+)\s*-->/;
  var PUBLIC_KEY_URL = '/api/crf/public-key';
  var drop = document.getElementById('drop');
  var fileInput = document.getElementById('file');
  var resultBox = document.getElementById('result');
  var errBox = document.getElementById('err');

  function normalizeCrf(text) {
    return text.replace(/\r\n?/g, '\n').split('\n')
      .filter(function (l) { return !l.startsWith('<!-- crf-signature:') && !l.startsWith('<!-- crf-verify:'); })
      .join('\n');
  }
  function sha256Hex(str) {
    var bytes = new TextEncoder().encode(str);
    return crypto.subtle.digest('SHA-256', bytes).then(function (buf) {
      return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
    });
  }
  function b64urlToBytes(b64url) {
    var b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function pemToCryptoKey(pem) {
    var b64 = pem.replace(/-----BEGIN PUBLIC KEY-----/, '').replace(/-----END PUBLIC KEY-----/, '').replace(/\s+/g, '');
    var der = b64urlToBytes(b64.replace(/\+/g, '-').replace(/\//g, '_'));
    return crypto.subtle.importKey('spki', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  }
  function metaOf(text) {
    function grab(k) {
      var m = text.match(new RegExp('<!--\\s*' + k + ':\\s*([^\\r\\n]+?)\\s*-->'));
      return m ? m[1].trim() : null;
    }
    return { title: grab('title'), model: grab('model'), source: grab('source') };
  }

  function show(kind, html) {
    resultBox.style.display = 'block';
    resultBox.innerHTML = '<div class="badge ' + kind + '">' + html + '</div>';
  }
  function showMeta(meta, ts) {
    var lines = '';
    if (meta.title) lines += '<div><b>标题</b>：' + meta.title + '</div>';
    if (meta.model) lines += '<div><b>模型</b>：' + meta.model + '</div>';
    if (meta.source) lines += '<div><b>来源</b>：' + meta.source + '</div>';
    if (ts) lines += '<div><b>导出时间</b>：' + new Date(ts * 1000).toLocaleString('zh-CN') + '</div>';
    if (lines) resultBox.innerHTML += '<div class="meta">' + lines + '</div>';
  }

  function verify(text) {
    var m = text.match(SIG_RE);
    var meta = metaOf(text);
    if (!m) {
      show('warn', '⚠️ <b>该文件无官方签名</b>，无法确认内容是否被篡改。<br>可能为旧版导出或第三方对话文件。');
      showMeta(meta);
      return;
    }
    var keyId = m[1], sigB64 = m[2], ts = m[3];
    sha256Hex(normalizeCrf(text)).then(function (hash) {
      var payload = hash + '.' + ts;
      return fetch(PUBLIC_KEY_URL)
        .then(function (r) { return r.json(); })
        .then(function (data) {
          var key = data.keys.filter(function (k) { return k.keyId === keyId; })[0];
          if (!key) throw new Error('未知的 keyId: ' + keyId);
          return pemToCryptoKey(key.pem);
        })
        .then(function (cryptoKey) {
          return crypto.subtle.verify(
            { name: 'ECDSA', hash: 'SHA-256' },
            cryptoKey,
            b64urlToBytes(sigB64),
            new TextEncoder().encode(payload)
          );
        })
        .then(function (ok) {
          if (ok) {
            var label = meta.source && meta.source.indexOf('thirdparty') === 0
              ? '✓ <b>官方导出 · 内容未被篡改</b>'
              : '✓ <b>官方认证 · 内容未被篡改</b>';
            show('ok', label);
          } else {
            show('bad', '❌ <b>签名无效：文件已被篡改</b>，不是 RAI 官方导出的原始内容。');
          }
          showMeta(meta, Number(ts));
        });
    }).catch(function (e) {
      errBox.style.display = 'block';
      errBox.textContent = '验证失败：' + e.message;
    });
  }

  function readAndVerify(file) {
    if (!file) return;
    errBox.style.display = 'none';
    resultBox.style.display = 'none';
    var reader = new FileReader();
    reader.onload = function () { verify(String(reader.result || '')); };
    reader.onerror = function () { errBox.style.display = 'block'; errBox.textContent = '读取文件失败'; };
    reader.readAsText(file, 'utf-8');
  }

  drop.addEventListener('click', function () { fileInput.click(); });
  drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('drag'); });
  drop.addEventListener('dragleave', function () { drop.classList.remove('drag'); });
  drop.addEventListener('drop', function (e) {
    e.preventDefault();
    drop.classList.remove('drag');
    readAndVerify(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', function () { readAndVerify(fileInput.files[0]); });
})();
