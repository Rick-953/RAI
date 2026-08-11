// crf-ui.js — CRF 导入/导出 UI（独立模块，不侵入 app.js）
// 依赖：appState（app.js 顶层 const，同全局词法环境可访问）、closeSessionMenu / isChineseLanguage（app.js 全局函数）、服务端 /api/crf/* 接口
(function () {
  'use strict';

  function toast(message, kind) {
    var old = document.getElementById('crfToast');
    if (old) old.remove();
    var el = document.createElement('div');
    el.id = 'crfToast';
    el.className = 'crf-toast crf-toast-' + (kind || 'info');
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(function () { el.classList.add('crf-toast-hide'); setTimeout(function () { el.remove(); }, 400); }, 3200);
  }

  function currentSessionId() {
    return (typeof appState !== 'undefined' && appState.currentSession && appState.currentSession.id) || null;
  }
  function authToken() {
    return (typeof appState !== 'undefined' && appState.token) || '';
  }

  function ensureFileInput() {
    var el = document.getElementById('crfFileInput');
    if (el) return el;
    el = document.createElement('input');
    el.id = 'crfFileInput';
    el.type = 'file';
    el.accept = '.crf,.txt';
    el.style.display = 'none';
    el.addEventListener('change', function () {
      if (el.files && el.files[0]) importFile(el.files[0]);
      el.value = '';
    });
    document.body.appendChild(el);
    return el;
  }

  async function exportCurrentSession(sessionId) {
    var sid = sessionId || currentSessionId();
    if (!sid) { toast('请先打开一个对话，再点击导出', 'warn'); return; }
    try {
      var resp = await fetch('/api/sessions/' + encodeURIComponent(sid) + '/export-crf', {
        headers: { Authorization: 'Bearer ' + authToken() }
      });
      var data = await resp.json().catch(function () { return null; });
      if (!resp.ok || !data || !data.success) {
        toast('导出失败：' + ((data && data.error) || ('HTTP ' + resp.status)), 'bad');
        return;
      }
      var blob = new Blob([data.content], { type: 'text/plain;charset=utf-8' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = data.filename || 'conversation.crf';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
      toast('已导出 CRF（含官方签名）', 'ok');
    } catch (e) {
      toast('导出失败：' + e.message, 'bad');
    }
  }

  async function importFile(file) {
    var text;
    try {
      text = await file.text();
    } catch (e) {
      toast('读取文件失败', 'bad');
      return;
    }
    try {
      var resp = await fetch('/api/crf/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + authToken() },
        body: JSON.stringify({ content: text })
      });
      var data = await resp.json().catch(function () { return null; });
      if (resp.ok && data && data.success) {
        var v = data.verification || {};
        var badge = v.status === 'valid' ? '✓ 官方认证' : (v.status === 'unsigned' ? '未认证' : v.status);
        toast('导入成功（' + badge + '）', 'ok');
        setTimeout(function () { location.reload(); }, 1200);
      } else {
        var err = data && data.error;
        var msg = err === 'crf_tampered' ? '拒绝导入：文件已被篡改（签名无效）'
          : err === 'crf_unsigned_official' ? '拒绝导入：官方对话缺少签名'
          : err === 'invalid_crf' ? '不是有效的 CRF 文件'
          : ('导入失败：' + (err || ('HTTP ' + resp.status)));
        toast(msg, 'bad');
      }
    } catch (e) {
      toast('导入失败：' + e.message, 'bad');
    }
  }

  // 向三点菜单末尾注入 CRF 导入/导出按钮（幂等：marker 标记或按钮存在即跳过）
  function injectMenuButtons(menu) {
    if (menu.dataset.crfInjected) return;
    if (menu.querySelector('button[data-action="export-crf"], button[data-action="import-crf"]')) return;
    var isZh = typeof appState !== 'undefined' && typeof isChineseLanguage === 'function'
      ? isChineseLanguage(appState.language)
      : true;

    var exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.setAttribute('data-action', 'export-crf');
    exportBtn.textContent = isZh ? '导出 CRF' : 'Export CRF';
    exportBtn.addEventListener('click', function (event) {
      event.stopPropagation();
      closeSessionMenu();
      exportCurrentSession(menu.dataset.sessionId);
    });

    var importBtn = document.createElement('button');
    importBtn.type = 'button';
    importBtn.setAttribute('data-action', 'import-crf');
    importBtn.textContent = isZh ? '导入 CRF' : 'Import CRF';
    importBtn.addEventListener('click', function (event) {
      event.stopPropagation();
      closeSessionMenu();
      ensureFileInput().click();
    });

    menu.appendChild(exportBtn);
    menu.appendChild(importBtn);
    menu.dataset.crfInjected = '1';
  }

  // 监听 body 直系子节点新增：菜单是动态 appendChild 到 body 的，出现即注入，替代旧的轮询
  var observer = new MutationObserver(function (mutations) {
    for (var i = 0; i < mutations.length; i++) {
      var nodes = mutations[i].addedNodes;
      for (var j = 0; j < nodes.length; j++) {
        var node = nodes[j];
        if (node.nodeType === 1 && node.classList && node.classList.contains('session-context-menu')) {
          injectMenuButtons(node);
        }
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: false });
})();