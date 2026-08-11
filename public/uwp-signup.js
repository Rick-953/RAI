(function () {
  'use strict';

  var state = {
    email: '',
    password: '',
    busy: false
  };

  function byId(id) {
    return document.getElementById(id);
  }

  function trim(value) {
    return String(value || '').replace(/^\s+|\s+$/g, '');
  }

  function setHidden(element, hidden) {
    if (!element) return;
    if (hidden) {
      element.setAttribute('hidden', 'hidden');
      element.setAttribute('aria-hidden', 'true');
    } else {
      element.removeAttribute('hidden');
      element.setAttribute('aria-hidden', 'false');
    }
  }

  function showStatus(message, isInfo) {
    var box = byId('statusMessage');
    box.className = isInfo ? 'status-message info' : 'status-message';
    box.textContent = message;
    setHidden(box, false);
  }

  function clearStatus() {
    var box = byId('statusMessage');
    box.textContent = '';
    setHidden(box, true);
  }

  function setBusy(busy, button, busyText, normalText) {
    state.busy = busy;
    byId('registerButton').disabled = busy;
    byId('verifyButton').disabled = busy;
    byId('resendButton').disabled = busy;
    if (button) button.textContent = busy ? busyText : normalText;
  }

  function parseResponse(xhr) {
    var data = null;
    try {
      data = JSON.parse(xhr.responseText || '{}');
    } catch (ignore) {
      data = null;
    }
    return data;
  }

  function postJson(url, payload, callback) {
    var xhr = new XMLHttpRequest();
    var finished = false;
    function finish(error, data) {
      if (finished) return;
      finished = true;
      callback(error, data);
    }
    xhr.open('POST', url, true);
    xhr.setRequestHeader('Content-Type', 'application/json;charset=UTF-8');
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.timeout = 25000;
    xhr.onreadystatechange = function () {
      var data;
      if (xhr.readyState !== 4) return;
      data = parseResponse(xhr);
      if (xhr.status >= 200 && xhr.status < 300 && data && data.success !== false) {
        finish(null, data);
        return;
      }
      finish((data && data.error) || '注册服务暂时不可用，请稍后再试。', data);
    };
    xhr.onerror = function () {
      finish('网络连接失败，请检查网络后重试。', null);
    };
    xhr.ontimeout = function () {
      finish('请求超时，请稍后重试。', null);
    };
    xhr.send(JSON.stringify(payload));
  }

  function isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  }

  function showVerification(email) {
    state.email = email;
    byId('verificationEmail').textContent = email;
    setHidden(byId('registrationForm'), true);
    setHidden(byId('verificationForm'), false);
    showStatus('请输入邮件中的验证码以完成注册。', true);
    byId('verificationCode').focus();
  }

  function showCompletion() {
    state.password = '';
    clearStatus();
    setHidden(byId('registrationForm'), true);
    setHidden(byId('verificationForm'), true);
    setHidden(byId('completionView'), false);
    byId('completionView').focus();
  }

  function submitRegistration(event) {
    var email;
    var username;
    var password;
    var passwordConfirm;
    var button;
    if (event && event.preventDefault) event.preventDefault();
    if (state.busy) return false;

    email = trim(byId('email').value).toLowerCase();
    username = trim(byId('username').value);
    password = byId('password').value || '';
    passwordConfirm = byId('passwordConfirm').value || '';

    if (!isValidEmail(email) || email.length > 254) {
      showStatus('请输入有效的邮箱地址。', false);
      byId('email').focus();
      return false;
    }
    if (username.length > 80) {
      showStatus('用户名不能超过 80 个字符。', false);
      byId('username').focus();
      return false;
    }
    if (password.length < 8 || password.length > 128) {
      showStatus('密码需要 8-128 个字符。', false);
      byId('password').focus();
      return false;
    }
    if (password !== passwordConfirm) {
      showStatus('两次输入的密码不一致。', false);
      byId('passwordConfirm').focus();
      return false;
    }

    clearStatus();
    state.email = email;
    state.password = password;
    button = byId('registerButton');
    setBusy(true, button, '注册中...', '注册');
    postJson('/api/auth/register', {
      email: email,
      username: username,
      password: password,
      registrationOnly: true
    }, function (error, data) {
      setBusy(false, button, '注册中...', '注册');
      if (error) {
        showStatus(error, false);
        return;
      }
      if (data && data.requiresEmailVerification) {
        showVerification(data.email || email);
        return;
      }
      showCompletion();
    });
    return false;
  }

  function submitVerification(event) {
    var code;
    var button;
    if (event && event.preventDefault) event.preventDefault();
    if (state.busy) return false;
    code = trim(byId('verificationCode').value);
    if (!/^\d{6}$/.test(code)) {
      showStatus('请输入 6 位数字邮箱验证码。', false);
      byId('verificationCode').focus();
      return false;
    }

    clearStatus();
    button = byId('verifyButton');
    setBusy(true, button, '验证中...', '验证并完成注册');
    postJson('/api/auth/register/verify', {
      email: state.email,
      code: code,
      registrationOnly: true
    }, function (error) {
      setBusy(false, button, '验证中...', '验证并完成注册');
      if (error) {
        showStatus(error, false);
        return;
      }
      showCompletion();
    });
    return false;
  }

  function resendCode() {
    var button;
    if (state.busy) return;
    if (!state.email || !state.password) {
      showStatus('注册资料已失效，请刷新页面后重新注册。', false);
      return;
    }
    clearStatus();
    button = byId('resendButton');
    setBusy(true, button, '发送中...', '重新发送验证码');
    postJson('/api/auth/register/resend', {
      email: state.email,
      password: state.password,
      registrationOnly: true
    }, function (error, data) {
      setBusy(false, button, '发送中...', '重新发送验证码');
      if (error) {
        showStatus(error, false);
        return;
      }
      if (data && data.requiresEmailVerification) {
        showStatus('新的验证码已发送，请检查邮箱。', true);
        return;
      }
      showCompletion();
    });
  }

  function initialize() {
    byId('registrationForm').addEventListener('submit', submitRegistration, false);
    byId('verificationForm').addEventListener('submit', submitVerification, false);
    byId('resendButton').addEventListener('click', resendCode, false);
    byId('email').focus();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, false);
  } else {
    initialize();
  }
}());
