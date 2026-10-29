(function () {
  'use strict';

  var messages = {
    'zh-CN': {
      language: '界面语言', auto: '跟随浏览器',
      sharePageTitle: 'RAI · 分享的对话', shareSubtitle: '分享的对话 · 只读快照',
      shareLoading: '正在读取对话…', shareInvalid: '无效的分享链接',
      shareFailed: '无法打开分享', shareExpired: '分享已过期、已撤销或不存在。',
      shareNetwork: '暂时无法读取对话，请检查网络后重试。',
      openNative: '在 CX RAI 中打开', backToWeb: '返回 RAI Web',
      conversation: '对话内容', user: '用户',
      shareHandoff: '正在尝试打开 CX RAI；若浏览器阻止，请点击“在 CX RAI 中打开”，或直接在此阅读。',
      shareNotice: '此页面由用户分享，内容不代表 RAI 官方观点。不要执行来源不明的命令或泄露个人信息。',
      signupPageTitle: 'RAI UWP 用户注册', signupPageName: 'UWP 用户注册',
      signupHeading: '创建 RAI 账号', email: '邮箱', username: '用户名（可选）',
      password: '密码', passwordConfirm: '确认密码',
      passwordHint: '至少 8 个字符，请勿使用常见密码或邮箱、用户名中的明显片段。',
      rememberPassword: '记住密码（由设备密码管理器保存）', register: '注册',
      verificationSent: '验证码已发送到', verificationCode: '邮箱验证码',
      verificationHint: '请输入邮件中的 6 位数字验证码，验证码 5 分钟内有效。',
      verify: '验证并完成注册', resend: '重新发送验证码',
      completed: '感谢您的注册，您现在可以返回UWP登录页登录了',
      serviceUnavailable: '注册服务暂时不可用，请稍后再试。',
      networkError: '网络连接失败，请检查网络后重试。', timeout: '请求超时，请稍后重试。',
      enterCode: '请输入邮件中的验证码以完成注册。', invalidEmail: '请输入有效的邮箱地址。',
      usernameTooLong: '用户名不能超过 80 个字符。', passwordLength: '密码需要 8-128 个字符。',
      passwordMismatch: '两次输入的密码不一致。', registering: '注册中...', verifying: '验证中...',
      invalidCodeLength: '请输入 6 位数字邮箱验证码。',
      registrationExpired: '注册资料已失效，请刷新页面后重新注册。',
      sending: '发送中...', codeResent: '新的验证码已发送，请检查邮箱。',
      emailRegistered: '该邮箱已被注册，请返回登录页登录。', invalidCode: '验证码无效或已过期，请重新发送验证码。',
      rateLimited: '请求过于频繁，请稍后重试。',
      emailDeliveryFailed: '验证邮件发送失败，请稍后再试；若问题持续，请联系支持。',
      passwordPolicy: '密码不符合安全要求，请避免常见密码、已泄露密码及邮箱或用户名中的明显片段。',
      usernameInvalid: '用户名不符合要求，请修改后重试。',
      requestRejected: '无法完成注册，请检查填写的信息后重试。'
    },
    en: {
      language: 'Interface language', auto: 'Follow browser',
      sharePageTitle: 'RAI · Shared conversation', shareSubtitle: 'Shared conversation · Read-only snapshot',
      shareLoading: 'Loading conversation...', shareInvalid: 'Invalid share link',
      shareFailed: 'Unable to open this conversation', shareExpired: 'This share has expired, has been revoked, or does not exist.',
      shareNetwork: 'The conversation could not be loaded. Check your connection and try again.',
      openNative: 'Open in CX RAI', backToWeb: 'Back to RAI Web',
      conversation: 'Conversation content', user: 'User',
      shareHandoff: 'Trying to open CX RAI. If your browser blocks it, select Open in CX RAI or keep reading here.',
      shareNotice: 'This conversation was shared by a user and does not represent the views of RAI. Do not run commands from unknown sources or disclose personal information.',
      signupPageTitle: 'RAI UWP registration', signupPageName: 'UWP registration',
      signupHeading: 'Create a RAI account', email: 'Email', username: 'Username (optional)',
      password: 'Password', passwordConfirm: 'Confirm password',
      passwordHint: 'Use at least 8 characters. Avoid common passwords or obvious parts of your email address or username.',
      rememberPassword: 'Remember password (using your device password manager)', register: 'Register',
      verificationSent: 'A verification code was sent to', verificationCode: 'Email verification code',
      verificationHint: 'Enter the 6-digit code from your email. The code expires after 5 minutes.',
      verify: 'Verify and complete registration', resend: 'Resend verification code',
      completed: 'Your account is ready. Return to the UWP sign-in page to sign in.',
      serviceUnavailable: 'Registration is temporarily unavailable. Please try again later.',
      networkError: 'Unable to connect. Check your internet connection and try again.', timeout: 'The request timed out. Please try again.',
      enterCode: 'Enter the code from your email to complete registration.', invalidEmail: 'Enter a valid email address.',
      usernameTooLong: 'Your username must be no longer than 80 characters.', passwordLength: 'Your password must contain 8-128 characters.',
      passwordMismatch: 'The passwords do not match.', registering: 'Registering...', verifying: 'Verifying...',
      invalidCodeLength: 'Enter the 6-digit email verification code.',
      registrationExpired: 'Your registration details have expired. Refresh the page and register again.',
      sending: 'Sending...', codeResent: 'A new verification code has been sent. Check your email.',
      emailRegistered: 'This email address is already registered. Return to the sign-in page to sign in.',
      invalidCode: 'The verification code is invalid or has expired. Request a new code.',
      rateLimited: 'Too many requests. Please try again later.',
      emailDeliveryFailed: 'The verification email could not be sent. Try again later, or contact support if the problem continues.',
      passwordPolicy: 'This password does not meet the security requirements. Avoid common or compromised passwords and obvious parts of your email address or username.',
      usernameInvalid: 'This username does not meet the requirements. Change it and try again.',
      requestRejected: 'Registration could not be completed. Check your details and try again.'
    },
    'zh-TW': {
      language: '介面語言', auto: '跟隨瀏覽器',
      sharePageTitle: 'RAI · 分享的對話', shareSubtitle: '分享的對話 · 唯讀快照',
      shareLoading: '正在讀取對話…', shareInvalid: '無效的分享連結',
      shareFailed: '無法開啟分享', shareExpired: '分享已過期、已撤銷或不存在。',
      shareNetwork: '暫時無法讀取對話，請檢查網路後重試。',
      openNative: '在 CX RAI 中開啟', backToWeb: '返回 RAI Web',
      conversation: '對話內容', user: '使用者',
      shareHandoff: '正在嘗試開啟 CX RAI；若瀏覽器阻擋，請點選「在 CX RAI 中開啟」，或直接在此閱讀。',
      shareNotice: '此頁面由使用者分享，內容不代表 RAI 官方觀點。不要執行來源不明的命令或洩露個人資訊。',
      signupPageTitle: 'RAI UWP 使用者註冊', signupPageName: 'UWP 使用者註冊',
      signupHeading: '建立 RAI 帳號', email: '電子郵件', username: '使用者名稱（選填）',
      password: '密碼', passwordConfirm: '確認密碼',
      passwordHint: '至少 8 個字元，請勿使用常見密碼或電子郵件、使用者名稱中的明顯片段。',
      rememberPassword: '記住密碼（由裝置密碼管理員儲存）', register: '註冊',
      verificationSent: '驗證碼已傳送至', verificationCode: '電子郵件驗證碼',
      verificationHint: '請輸入電子郵件中的 6 位數字驗證碼，驗證碼 5 分鐘內有效。',
      verify: '驗證並完成註冊', resend: '重新傳送驗證碼',
      completed: '感謝您的註冊，現在可以返回 UWP 登入頁登入。',
      serviceUnavailable: '註冊服務暫時無法使用，請稍後再試。',
      networkError: '網路連線失敗，請檢查網路後重試。', timeout: '請求逾時，請稍後重試。',
      enterCode: '請輸入電子郵件中的驗證碼以完成註冊。', invalidEmail: '請輸入有效的電子郵件地址。',
      usernameTooLong: '使用者名稱不能超過 80 個字元。', passwordLength: '密碼需要 8-128 個字元。',
      passwordMismatch: '兩次輸入的密碼不一致。', registering: '註冊中...', verifying: '驗證中...',
      invalidCodeLength: '請輸入 6 位數字電子郵件驗證碼。',
      registrationExpired: '註冊資料已失效，請重新整理頁面後重新註冊。',
      sending: '傳送中...', codeResent: '新的驗證碼已傳送，請檢查電子郵件。',
      emailRegistered: '此電子郵件地址已被註冊，請返回登入頁登入。', invalidCode: '驗證碼無效或已過期，請重新傳送驗證碼。',
      rateLimited: '請求過於頻繁，請稍後重試。',
      emailDeliveryFailed: '驗證郵件傳送失敗，請稍後再試；若問題持續，請聯絡支援。',
      passwordPolicy: '密碼不符合安全要求，請避免常見密碼、已洩露密碼及電子郵件或使用者名稱中的明顯片段。',
      usernameInvalid: '使用者名稱不符合要求，請修改後重試。',
      requestRejected: '無法完成註冊，請檢查填寫的資訊後重試。'
    }
  };

  function text(key) {
    var language = window.RAILocale ? window.RAILocale.getLanguage() : document.documentElement.lang;
    return (messages[language] || messages.en)[key] || messages.en[key] || key;
  }

  function render() {
    var elements = document.querySelectorAll('[data-entry-i18n]');
    var labels = document.querySelectorAll('[data-entry-i18n-aria-label]');
    var index;
    for (index = 0; index < elements.length; index += 1) {
      elements[index].textContent = text(elements[index].getAttribute('data-entry-i18n'));
    }
    for (index = 0; index < labels.length; index += 1) {
      labels[index].setAttribute('aria-label', text(labels[index].getAttribute('data-entry-i18n-aria-label')));
    }
    var control = document.getElementById('entryLanguage');
    if (control && window.RAILocale) control.value = window.RAILocale.getPreference();
  }

  function initialize() {
    var control = document.getElementById('entryLanguage');
    if (control && window.RAILocale) {
      control.addEventListener('change', function () { window.RAILocale.setPreference(control.value); }, false);
      window.RAILocale.subscribe(render);
    }
    render();
  }

  window.RAIEntryI18n = { text: text, render: render };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, false);
  else initialize();
}());
