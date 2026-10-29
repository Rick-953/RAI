(function () {
  'use strict';

  var state = {
    email: '',
    password: '',
    busy: false,
    statusKey: '',
    busyButton: null,
    busyTextKey: ''
  };
  var text = window.RAIEntryI18n.text;

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

  function showStatus(messageKey, isInfo) {
    var box = byId('statusMessage');
    state.statusKey = messageKey;
    box.className = isInfo ? 'status-message info' : 'status-message';
    box.textContent = text(messageKey);
    setHidden(box, false);
  }

  function clearStatus() {
    var box = byId('statusMessage');
    state.statusKey = '';
    box.textContent = '';
    setHidden(box, true);
  }

  function setBusy(busy, button, busyTextKey, normalTextKey) {
    state.busy = busy;
    state.busyButton = busy ? button : null;
    state.busyTextKey = busy ? busyTextKey : '';
    byId('registerButton').disabled = busy;
    byId('verifyButton').disabled = busy;
    byId('resendButton').disabled = busy;
    if (button) button.textContent = text(busy ? busyTextKey : normalTextKey);
  }

  function renderState() {
    if (state.statusKey) byId('statusMessage').textContent = text(state.statusKey);
    if (state.busyButton) state.busyButton.textContent = text(state.busyTextKey);
  }

  function responseErrorKey(xhr, data) {
    var message = data && typeof data.error === 'string' ? data.error : '';
    if (xhr.status === 429) return 'rateLimited';
    if (/已被注册|already registered/i.test(message)) return 'emailRegistered';
    if (/邮件发送失败|email.*(?:send|deliver).*fail/i.test(message)) return 'emailDeliveryFailed';
    if (/验证码|verification code|email code/i.test(message)) return 'invalidCode';
    if (/邮件格式|邮箱.*格式|invalid email/i.test(message)) return 'invalidEmail';
    if (/密码|password/i.test(message)) return 'passwordPolicy';
    if (/用户名|username/i.test(message)) return 'usernameInvalid';
    return xhr.status >= 400 && xhr.status < 500 ? 'requestRejected' : 'serviceUnavailable';
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
      finish(responseErrorKey(xhr, data), data);
    };
    xhr.onerror = function () {
      finish('networkError', null);
    };
    xhr.ontimeout = function () {
      finish('timeout', null);
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
    showStatus('enterCode', true);
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
      showStatus('invalidEmail', false);
      byId('email').focus();
      return false;
    }
    if (username.length > 80) {
      showStatus('usernameTooLong', false);
      byId('username').focus();
      return false;
    }
    if (password.length < 8 || password.length > 128) {
      showStatus('passwordLength', false);
      byId('password').focus();
      return false;
    }
    if (password !== passwordConfirm) {
      showStatus('passwordMismatch', false);
      byId('passwordConfirm').focus();
      return false;
    }

    clearStatus();
    state.email = email;
    state.password = password;
    button = byId('registerButton');
    setBusy(true, button, 'registering', 'register');
    postJson('/api/auth/register', {
      email: email,
      username: username,
      password: password,
      registrationOnly: true
    }, function (error, data) {
      setBusy(false, button, 'registering', 'register');
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
      showStatus('invalidCodeLength', false);
      byId('verificationCode').focus();
      return false;
    }

    clearStatus();
    button = byId('verifyButton');
    setBusy(true, button, 'verifying', 'verify');
    postJson('/api/auth/register/verify', {
      email: state.email,
      code: code,
      registrationOnly: true
    }, function (error) {
      setBusy(false, button, 'verifying', 'verify');
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
      showStatus('registrationExpired', false);
      return;
    }
    clearStatus();
    button = byId('resendButton');
    setBusy(true, button, 'sending', 'resend');
    postJson('/api/auth/register/resend', {
      email: state.email,
      password: state.password,
      registrationOnly: true
    }, function (error, data) {
      setBusy(false, button, 'sending', 'resend');
      if (error) {
        showStatus(error, false);
        return;
      }
      if (data && data.requiresEmailVerification) {
        showStatus('codeResent', true);
        return;
      }
      showCompletion();
    });
  }

  function syncRememberPreference(enabled, persist) {
    byId('rememberPassword').checked = enabled;
    byId('password').setAttribute('autocomplete', enabled ? 'new-password' : 'off');
    byId('passwordConfirm').setAttribute('autocomplete', enabled ? 'new-password' : 'off');
    if (persist) {
      try { localStorage.setItem('rai_remember_password', enabled ? 'true' : 'false'); }
      catch (error) { /* storage disabled */ }
    }
  }

  function initialize() {
    var enabled = true;
    if (window.RAILocale) window.RAILocale.subscribe(renderState);
    try { enabled = localStorage.getItem('rai_remember_password') !== 'false'; }
    catch (error) { /* default on */ }
    syncRememberPreference(enabled, false);
    byId('rememberPassword').addEventListener('change', function (event) {
      syncRememberPreference(event.target.checked, true);
    }, false);

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
