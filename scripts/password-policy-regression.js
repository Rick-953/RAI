#!/usr/bin/env node

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const {
  PASSWORD_POLICY_VERSION,
  PASSWORD_MIN_LENGTH,
  checkPasswordCompromise,
  hashPassword,
  isCurrentPasswordHash,
  validateExistingPasswordInput,
  validateNewPasswordPolicy,
  verifyPassword
} = require('../lib/password-policy');

async function main() {
  assert.equal(PASSWORD_POLICY_VERSION, 2);
  assert.equal(PASSWORD_MIN_LENGTH, 8);
  assert.match(validateNewPasswordPolicy('Ab3!xY7'), /8/);
  assert.equal(validateNewPasswordPolicy('Rai#953x'), '');
  assert.match(validateNewPasswordPolicy('correct horse battery staple'), /常见/);
  assert.match(
    validateNewPasswordPolicy('alice-really-long-secret-value', { email: 'alice@example.com' }),
    /邮箱|用户名/
  );
  assert.equal(validateNewPasswordPolicy('Mango River Quartz! 953'), '');
  assert.equal(validateExistingPasswordInput('legacy-six'), '');

  const longPrefix = '界'.repeat(30);
  const longOne = `${longPrefix}-one-RAI-953`;
  const longTwo = `${longPrefix}-two-RAI-953`;
  assert.equal(Buffer.from(longOne).subarray(0, 72).equals(Buffer.from(longTwo).subarray(0, 72)), true);
  const currentHash = await hashPassword(longOne, 4);
  assert.equal(isCurrentPasswordHash(currentHash), true);
  assert.equal(await verifyPassword(longOne, currentHash), true);
  assert.equal(await verifyPassword(longTwo, currentHash), false, 'v2 prehash must distinguish bytes beyond bcrypt byte 72');

  const legacyHash = await bcrypt.hash('legacy-password-value', 4);
  assert.equal(await verifyPassword('legacy-password-value', legacyHash), true, 'legacy bcrypt hashes must remain readable for migration');

  const compromisedPassword = 'password';
  const sha1 = crypto.createHash('sha1').update(compromisedPassword).digest('hex').toUpperCase();
  let observedRequest = null;
  const compromise = await checkPasswordCompromise(compromisedPassword, {
    now: 1000,
    fetchImpl: async (requestUrl, options) => {
      observedRequest = { requestUrl, options };
      return new Response(`${sha1.slice(5)}:999\r\n${'A'.repeat(35)}:0\r\n`, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' }
      });
    }
  });
  assert.deepEqual(compromise, { checked: true, compromised: true, count: 999 });
  assert.equal(observedRequest.requestUrl.endsWith(`/${sha1.slice(0, 5)}`), true);
  const observedUrl = new URL(observedRequest.requestUrl);
  assert.equal(observedUrl.pathname.split('/').pop(), sha1.slice(0, 5), 'only the five-character hash prefix may enter the request URL');
  assert.equal(observedUrl.search, '', 'plaintext password must never enter the request query');
  assert.equal(observedRequest.options.headers['Add-Padding'], 'true');
  assert.equal(observedRequest.options.redirect, 'error');

  const safePassword = 'Mango River Quartz! 953';
  const safeResult = await checkPasswordCompromise(safePassword, {
    now: 2000,
    fetchImpl: async () => new Response(`${'B'.repeat(35)}:7\r\n`, { status: 200 })
  });
  assert.equal(safeResult.checked, true);
  assert.equal(safeResult.compromised, false);

  const unavailableResult = await checkPasswordCompromise('Unique unavailable check 953!', {
    now: 3000,
    fetchImpl: async () => { throw new Error('synthetic network outage'); }
  });
  assert.deepEqual(unavailableResult, { checked: false, compromised: false, count: 0 });

  let oversizedBodyCancelled = false;
  const oversizedResult = await checkPasswordCompromise('Unique oversized range check 953!', {
    now: 4000,
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(200 * 1024));
        controller.enqueue(new Uint8Array(100 * 1024));
      },
      cancel() {
        oversizedBodyCancelled = true;
      }
    }), { status: 200 })
  });
  assert.deepEqual(oversizedResult, { checked: false, compromised: false, count: 0 });
  assert.equal(oversizedBodyCancelled, true, 'oversized chunked breach responses must be cancelled before unbounded buffering');

  const fs = require('fs');
  const path = require('path');
  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const harnessSource = fs.readFileSync(path.join(__dirname, 'security-smoke-harness.js'), 'utf8');
  const validatorStart = serverSource.indexOf('async function validateNewPasswordForAccount');
  const validatorEnd = serverSource.indexOf('function buildPasswordUpgradeRequiredPayload', validatorStart);
  const validatorSource = serverSource.slice(validatorStart, validatorEnd);
  assert.ok(validatorStart >= 0 && validatorEnd > validatorStart, 'account password validator source must be locatable');
  assert.match(validatorSource, /if \(!result\.checked\)/, 'account password validation must fail closed when the breach service is unavailable');
  assert.match(validatorSource, /暂时无法完成.*泄漏安全检查/, 'fail-closed response must be explicit and retryable');
  assert.match(serverSource, /DUMMY_LOGIN_PASSWORD_HASH/, 'unknown-account password login must use a timing-balancing hash');
  const passwordLoginRoute = serverSource.slice(
    serverSource.indexOf("app.post('/api/auth/login',"),
    serverSource.indexOf("app.post('/api/auth/login/email-code/request'", serverSource.indexOf("app.post('/api/auth/login',"))
  );
  assert.match(passwordLoginRoute, /if \(!user\) \{\s*await verifyPassword\(password, DUMMY_LOGIN_PASSWORD_HASH\)/, 'unknown-account password login must perform the same bcrypt class of work');
  assert.match(passwordLoginRoute, /buildPasswordUpgradeRequiredPayload\(user\.email\)/, 'verified weak legacy passwords must return the shared upgrade response');
  assert.match(serverSource, /function buildPasswordUpgradeRequiredPayload[\s\S]{0,240}code:\s*'password_upgrade_required'/, 'weak-password upgrade response must expose a stable code');
  assert.match(passwordLoginRoute, /legacyPasswordPolicyError[\s\S]{0,320}UPDATE users SET password_policy_version = 0/, 'recognized weak passwords must persist a fail-closed upgrade marker before email verification');
  assert.match(passwordLoginRoute, /!legacyPasswordPolicyError && !isCurrentPasswordHash/, 'only policy-compliant legacy passwords may be format-migrated');
  const unverifiedGate = passwordLoginRoute.indexOf('Number(user.email_verified ?? 1) !== 1');
  const weakPasswordGate = passwordLoginRoute.indexOf('if (legacyPasswordPolicyError && !provisionedTestAccount)', unverifiedGate);
  const twoFactorGate = passwordLoginRoute.indexOf('const twoFactorEnabled', weakPasswordGate);
  assert.ok(
    unverifiedGate >= 0 && weakPasswordGate > unverifiedGate && twoFactorGate > weakPasswordGate,
    'registration email verification must remain reachable before the weak-password gate, while 2FA/session issuance remains after it'
  );

  const registrationCompletion = serverSource.slice(
    serverSource.indexOf('async function completeRegistrationEmailVerification'),
    serverSource.indexOf("app.post('/api/auth/register',", serverSource.indexOf('async function completeRegistrationEmailVerification'))
  );
  assert.match(registrationCompletion, /password_policy_version[\s\S]{0,500}buildPasswordUpgradeRequiredPayload/, 'verified historical registrations must be redirected to reset before a session is issued');
  assert.ok(
    registrationCompletion.indexOf('buildPasswordUpgradeRequiredPayload') < registrationCompletion.indexOf('buildAuthenticatedUserPayload'),
    'legacy registration completion must enforce password upgrade before creating an authenticated session'
  );

  const resetRequestRoute = serverSource.slice(
    serverSource.indexOf('function queuePasswordResetEmail'),
    serverSource.indexOf("app.post('/api/auth/password/reset/confirm'", serverSource.indexOf('function queuePasswordResetEmail'))
  );
  assert.match(resetRequestRoute, /setImmediate\(/, 'password-reset lookup and delivery must run in one detached callback');
  assert.equal((resetRequestRoute.match(/return res\.json\(/g) || []).length, 1, 'valid password-reset requests must have one uniform public response');
  assert.match(resetRequestRoute, /如果邮箱存在，验证码会发送到该邮箱/, 'password-reset request must use a generic response');
  assert.doesNotMatch(resetRequestRoute, /res\.status\(502\)/, 'mail-provider failures must not enumerate an existing account');

  const resetConfirmRoute = serverSource.slice(
    serverSource.indexOf("app.post('/api/auth/password/reset/confirm'"),
    serverSource.indexOf("app.post('/api/auth/login/2fa'", serverSource.indexOf("app.post('/api/auth/password/reset/confirm'"))
  );
  const proofCheck = resetConfirmRoute.indexOf('verifyEmailCodeProof');
  const accountContextCheck = resetConfirmRoute.indexOf('username: user.username');
  const atomicConsume = resetConfirmRoute.indexOf('verifyAndConsumeEmailCodeWithinTransaction(tx');
  const passwordWrite = resetConfirmRoute.indexOf('SET password_hash = ?');
  assert.ok(proofCheck >= 0 && accountContextCheck > proofCheck,
    'password reset must prove mailbox control before exposing account-context password-policy feedback');
  assert.ok(atomicConsume > accountContextCheck && passwordWrite > atomicConsume,
    'valid reset proof consumption, password write, and session revocation must share the sensitive transaction');
  assert.match(resetConfirmRoute, /withSensitiveAccountMutation\(user\.id, async \(tx\) => \{/,
    'password reset must use the atomic sensitive-account mutation boundary');
  assert.match(resetConfirmRoute, /if \(!proof\.ok\)[\s\S]{0,180}验证码无效或已过期/,
    'invalid reset proofs must retain one non-enumerating response');

  const userPasswordRoute = serverSource.slice(
    serverSource.indexOf("app.put('/api/user/password'"),
    serverSource.indexOf("app.delete('/api/user/account'", serverSource.indexOf("app.put('/api/user/password'"))
  );
  assert.match(userPasswordRoute, /SELECT id, email, username, password_hash/, 'self-service password changes must load account context');
  assert.match(userPasswordRoute, /email:\s*user\.email,[\s\S]{0,80}username:\s*user\.username/, 'self-service password policy must reject account-derived secrets');
  const adminPasswordRoute = serverSource.slice(
    serverSource.indexOf("app.put('/api/admin/users/:userId/password'"),
    serverSource.indexOf("app.get('/api/admin/users/:userId/detail'", serverSource.indexOf("app.put('/api/admin/users/:userId/password'"))
  );
  assert.match(adminPasswordRoute, /SELECT id, email, username FROM users/, 'admin password reset must load target account context');
  assert.match(adminPasswordRoute, /email:\s*user\.email,[\s\S]{0,80}username:\s*user\.username/, 'admin password policy must reject target-account-derived secrets');

  const frontendAuthHandler = appSource.slice(
    appSource.indexOf('async function handleAuthServerResponse'),
    appSource.indexOf('async function requestLoginEmailCode', appSource.indexOf('async function handleAuthServerResponse'))
  );
  assert.match(frontendAuthHandler, /password_upgrade_required/, 'frontend must recognize the weak-password upgrade response');
  assert.match(frontendAuthHandler, /showForgotPasswordHelp\(\)/, 'frontend must open the recoverable email reset flow');
  assert.match(frontendAuthHandler, /passwordInput\.value = ''/, 'frontend must clear the rejected legacy password');

  const limiterSource = serverSource.slice(
    serverSource.indexOf('// 限流配置'),
    serverSource.indexOf('const emailAuthLimiter', serverSource.indexOf('// 限流配置'))
  );
  assert.match(limiterSource, /!IS_PRODUCTION[\s\S]{0,220}RAI_AUTH_RATE_LIMIT_MAX[\s\S]{0,160}: 20;/, 'auth limiter override must be test-only and production must remain fixed at 20');
  assert.match(harnessSource, /RAI_AUTH_RATE_LIMIT_MAX:\s*'200'/, 'isolated security smoke must explicitly opt into its larger auth matrix limit');
  const emailRequestRoute = serverSource.slice(
    serverSource.indexOf("app.post('/api/auth/login/email-code/request'"),
    serverSource.indexOf("app.post('/api/auth/login/email-code/verify'")
  );
  assert.match(emailRequestRoute, /genericResponse/, 'email-code requests must use a generic public response');
  assert.doesNotMatch(emailRequestRoute, /await sendEmailCodeOrReport/, 'email delivery latency must not reveal whether an account exists');
  assert.doesNotMatch(
    emailRequestRoute,
    /return res\.json\(\{[^}]+(?:requiresEmailVerification|email:\s*normalizedEmail)/,
    'email-code request responses must not disclose account state'
  );
  const emailVerifyRoute = serverSource.slice(
    serverSource.indexOf("app.post('/api/auth/login/email-code/verify'"),
    serverSource.indexOf("app.post('/api/auth/login/2fa'")
  );
  assert.match(emailVerifyRoute, /pendingRegistration \? 'register' : 'login'/, 'pending registrations must remain completable through the generic email-code flow');
  assert.match(emailVerifyRoute, /return res\.status\(401\)\.json\(\{ success: false, error: '验证码无效或已过期' \}\)/, 'invalid verification responses must be uniform');

  console.log('password-policy-regression ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
