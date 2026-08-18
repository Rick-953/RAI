#!/usr/bin/env node

'use strict';

// Onboarding guide / mascot / tap-target regression.
//
// Two harnesses are combined, mirroring the established repo patterns:
//  - runtime part  (scripts/beta-isolated-api-regression.js style): boots the
//    real server.js twice on ONE temp SQLite DB with a loopback-only network
//    guard and a fake loopback email service (RESEND_API_URL), exercises
//    /api/user/guide-state + /api/user/profile + auth register/verify/login.
//  - static part   (scripts/formal-user-bugs-regression.js style): reads the
//    shipped sources as strings and asserts on function names, sentinel
//    strings and semantic patterns (never on line numbers).
//
// This build's fake-email verification code is 6 digits
// (server.js generateEmailCode / ^\d{6}$), so the mail capturer uses the
// {6,32} extraction regex, NOT the older beta harness's {10,32}.
//
// Exit code 1 on any failure; never touches the real ai_data.db, uploads/,
// avatars/ or any production path.

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.resolve(__dirname, '..');
const RUN_ID = `${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
const REQUEST_TIMEOUT_MS = 12000;
const TEST_PASSWORD = 'AuditPass-123456';
const GUIDE_VERSION = 1;

// ---------------------------------------------------------------------------
// Static source loading (formal-user-bugs-regression style)
// ---------------------------------------------------------------------------

const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
const app = read('public/app.js');
const index = read('public/index.html');
const styles = read('public/styles.css');
const teaPetAsset = path.join(ROOT, 'public/images/pets/tea-pet.webp');
const serviceWorker = read('public/sw.js');
const serverSource = read('server.js');
const packageJson = JSON.parse(read('package.json'));

function extractNamedFunction(source, name) {
  const match = new RegExp(`function\\s+${name}\\s*\\(`).exec(source);
  assert.ok(match, `missing function: ${name}`);
  const signatureClose = source.indexOf(') {', match.index);
  assert.ok(signatureClose > match.index, `unsupported function signature: ${name}`);
  const bodyStart = signatureClose + 2;
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(match.index, index + 1);
    }
  }
  throw new Error(`unbalanced function: ${name}`);
}

function extractBracedBlock(source, bodyStart) {
  assert.equal(source[bodyStart], '{', 'braced block must start at an opening brace');
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart, index + 1);
    }
  }
  throw new Error('unbalanced braced block');
}

function extractNestedFunction(container, name) {
  const match = new RegExp(`function\\s+${name}\\s*\\(`).exec(container);
  assert.ok(match, `missing nested function: ${name}`);
  const openBrace = container.indexOf('{', match.index);
  assert.ok(openBrace > match.index, `unsupported nested function signature: ${name}`);
  return extractBracedBlock(container, openBrace);
}

// ---------------------------------------------------------------------------
// Static tests (mirrors the product test plan items a-i)
// ---------------------------------------------------------------------------

function testVersionConstants() {
  // 6a / 6i — version consistency across client, server and service worker.
  assert.match(serverSource, /const\s+GUIDE_VERSION\s*=\s*1\s*;/, 'server GUIDE_VERSION must be 1');
  assert.match(app, /const\s+RAI_GUIDE_VERSION\s*=\s*1\s*;/, 'RAI_GUIDE_VERSION must be 1');
  assert.match(app, /const\s+RAI_APP_VERSION\s*=\s*'0\.13\.6'\s*;/, 'RAI_APP_VERSION mismatch');
  assert.match(app, /const\s+RAI_BUILD_ID\s*=\s*'20260818-version-contract-v0136-r1'\s*;/, 'RAI_BUILD_ID mismatch');
  assert.match(serviceWorker, /const\s+RAI_SW_VERSION\s*=\s*'0\.13\.6-version-contract-v0136-r1'\s*;/, 'RAI_SW_VERSION mismatch');
  const markers = (index.match(/20260818-version-contract-v0136-r1/g) || []).length;
  assert.ok(markers >= 15, `index.html must carry >= 15 build markers, got ${markers}`);
  assert.match(index, /v0\.13\.6/, 'index.html must show the matching app version');
  assert.equal(packageJson.version, '0.13.6', 'package.json version mismatch');
}

function testGuideWiring() {
  // 6b — four-combo wiring.
  const mascotFn = extractNamedFunction(app, 'applyGuideMascotState');
  const tapFn = extractNamedFunction(app, 'applyGuideTapTargetState');
  const visibility = extractNamedFunction(app, 'syncGuideMascotVisibility');
  const presentation = extractNamedFunction(app, 'refreshGuideTargetPresentation');
  const hide = extractNamedFunction(app, 'hideMascot');
  const onboarding = extractNamedFunction(app, 'showOnboarding');

  assert.match(app, /window\.applyGuideMascotState\s*=\s*applyGuideMascotState\s*;/, 'applyGuideMascotState must be window-exposed');
  assert.match(app, /window\.applyGuideTapTargetState\s*=\s*applyGuideTapTargetState\s*;/, 'applyGuideTapTargetState must be window-exposed');

  // Disabling the mascot routes through the site-wide hide path.
  assert.match(mascotFn, /syncGuideMascotVisibility\(\)/, 'applyGuideMascotState must re-sync visibility');
  assert.match(mascotFn, /syncGuideStateToServer\(\{\s*mascotEnabled:/, 'applyGuideMascotState must sync mascotEnabled');
  assert.match(tapFn, /refreshGuideTargetPresentation\(\)/, 'applyGuideTapTargetState must refresh the target presentation');
  assert.match(tapFn, /syncGuideStateToServer\(\{\s*tapTargetEnabled:/, 'applyGuideTapTargetState must sync tapTargetEnabled');

  assert.match(visibility, /if\s*\(!mascot\s*\|\|\s*!appState\.guide\.mascotEnabled\)\s*\{\s*hideMascot\(\);\s*return;\s*\}/,
    'mascot disabled must call the site-wide hide path');

  // Disabling the tap target clears mask/ring but leaves the mascot alone.
  assert.match(presentation, /if\s*\(!appState\.guide\.tapTargetEnabled\)\s*\{\s*hideGuideTargetLayers\(\);\s*return;\s*\}/,
    'tap target disabled must clear the mask/ring layers');
  assert.doesNotMatch(presentation, /hideMascot/, 'tap-target presentation must never hide the mascot');
  assert.match(hide, /setMascotSpeech\('',\s*''\)/, 'hideMascot must clear the speech bubble');
  assert.match(hide, /raiMascotState\.mode\s*=\s*'hidden'/, 'hideMascot must set mode to hidden');

  // "Both off" start → finish() only (3 pages, teaching skipped).
  assert.match(onboarding, /if\s*\(appState\.guide\.mascotEnabled\s*\|\|\s*appState\.guide\.tapTargetEnabled\)\s*\{\s*beginGuideTeaching\(\);\s*\}\s*else\s*\{\s*finish\(\);\s*\}/,
    'start button must skip teaching when both toggles are off');
}

function testCompletionVersionRecording() {
  // 6c — skip and complete both record RAI_GUIDE_VERSION; replay never lowers it.
  const setCompleted = extractNamedFunction(app, 'setOnboardingCompleted');
  const writeMirror = extractNamedFunction(app, 'writeGuideCompletionMirror');
  const isCompleted = extractNamedFunction(app, 'isGuideCompleted');
  const onboarding = extractNamedFunction(app, 'showOnboarding');
  const replay = extractNamedFunction(app, 'replayOnboarding');

  assert.match(setCompleted, /Math\.max\(appState\.guide\.completedVersion,\s*RAI_GUIDE_VERSION\)/,
    'complete must use Math.max semantics (never lower)');
  assert.match(setCompleted, /writeGuideCompletionMirror\(/, 'complete must write the local mirror');
  assert.match(setCompleted, /syncGuideStateToServer\(\{[\s\S]*?completedVersion:\s*RAI_GUIDE_VERSION[\s\S]*?mascotEnabled:\s*false/,
    'complete must sync RAI_GUIDE_VERSION and the optional first-run mascot hide together');

  // Skip button routes through finish(), which calls setOnboardingCompleted.
  assert.match(onboarding, /skipBtn\.addEventListener\('click',\s*finish/, 'skip must go through finish()');

  // Replay / showOnboarding never touch completedVersion directly.
  assert.doesNotMatch(replay, /completedVersion\s*=/, 'replay must never write completedVersion');
  assert.doesNotMatch(onboarding, /completedVersion\s*=/, 'showOnboarding must never write completedVersion');

  // Mirror writes stay monotonic, while an authenticated server profile is
  // authoritative and cannot be overridden by another account's legacy key.
  assert.match(writeMirror, /Math\.max\(0,\s*Number\.parseInt\(version,\s*10\)\s*\|\|\s*0\)/,
    'mirror write must clamp with Math.max');
  assert.match(isCompleted, /if\s*\(hasAuthoritativeServerState\)\s*\{\s*return\s+Number\(appState\.guide\.completedVersion\)\s*>=\s*RAI_GUIDE_VERSION;\s*\}/,
    'authenticated server state must be the sole completion authority');
  assert.match(isCompleted, /if\s*\(identity\)\s*\{[\s\S]*?getOnboardingStorageKey\(user\)[\s\S]*?\}\s*return\s+localStorage\.getItem\('rai_onboarding_done'\)\s*===\s*'1'/,
    'the global legacy key may only be read before an account identity exists');
  assert.doesNotMatch(writeMirror, /localStorage\.setItem\('rai_onboarding_done',\s*'1'\)/,
    'authenticated completion must not keep polluting the global legacy key');
}

function testLegacyCompletionAccountIsolation() {
  const functionSource = extractNamedFunction(app, 'isGuideCompleted');
  const storage = new Map([
    ['rai_onboarding_done', '1'],
    ['rai_onboarding_done:completed-user', '1'],
    ['rai_onboarding_completed_version:completed-user', '1']
  ]);
  const localStorage = {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null;
    }
  };
  const RAI_GUIDE_VERSION = GUIDE_VERSION;
  const getGuideUserIdentity = (user) => String(user?.id || user?.email || '').trim();
  const getOnboardingStorageKey = (user) => {
    const identity = getGuideUserIdentity(user);
    return identity ? `rai_onboarding_done:${identity}` : 'rai_onboarding_done';
  };
  const getGuideCompletionStorageKey = (user) => {
    const identity = getGuideUserIdentity(user);
    return identity ? `rai_onboarding_completed_version:${identity}` : 'rai_onboarding_completed_version';
  };
  const readGuideCompletionMirror = (user) => Number.parseInt(
    localStorage.getItem(getGuideCompletionStorageKey(user)) || '0',
    10
  ) || 0;
  const buildCheck = (guide) => Function(
    'appState',
    'localStorage',
    'RAI_GUIDE_VERSION',
    'getGuideUserIdentity',
    'getOnboardingStorageKey',
    'readGuideCompletionMirror',
    `${functionSource}; return isGuideCompleted;`
  )(
    { guide },
    localStorage,
    RAI_GUIDE_VERSION,
    getGuideUserIdentity,
    getOnboardingStorageKey,
    readGuideCompletionMirror
  );

  const incompleteUser = { id: 'new-user' };
  const authoritativeIncomplete = buildCheck({
    serverAuthoritative: true,
    serverUserId: 'new-user',
    completedVersion: 0
  });
  assert.equal(authoritativeIncomplete(incompleteUser), false,
    'another account global/account legacy markers must not suppress this account onboarding');

  const authoritativeComplete = buildCheck({
    serverAuthoritative: true,
    serverUserId: 'completed-user',
    completedVersion: 1
  });
  assert.equal(authoritativeComplete({ id: 'completed-user' }), true,
    'the current account server completion must suppress repeat onboarding');

  const preProfileMirror = buildCheck({
    serverAuthoritative: false,
    serverUserId: '',
    completedVersion: 0
  });
  assert.equal(preProfileMirror({ id: 'completed-user' }), true,
    'the matching account mirror must bridge the pre-profile interval');
  assert.equal(preProfileMirror(incompleteUser), false,
    'the global legacy key must not cross account boundaries before profile load');
  assert.equal(preProfileMirror(null), true,
    'the global legacy key remains a compatibility fallback before identity is known');
}

function testRegistrationLanguagePromptRemoved() {
  assert.doesNotMatch(app, /showNewUserLanguagePrompt|localOnboardingLanguagePrompt/,
    'the duplicate post-registration language prompt must be absent');
  assert.doesNotMatch(app, /prompt\?\.action\s*===\s*'set_language'/,
    'ask-user cards must not retain the obsolete onboarding language branch');
}

function testGuideTriggerPaths() {
  // 引导触发以账号级完成版本为准（新老账号升级后都观看一次），
  // 且 token 恢复路径（刷新/重开/换设备）同样触发。
  const enter = extractNamedFunction(app, 'enterAuthenticatedApp');
  const maybeShow = extractNamedFunction(app, 'maybeShowOnboardingAfterAuth');
  const resolve = extractNamedFunction(app, 'resolveStartupAuthentication');

  assert.match(enter, /if\s*\(!hasCompletedOnboarding\(appState\.user\s*\|\|\s*data\.user\)\)\s*\{\s*showOnboarding\(\);/,
    'enterAuthenticatedApp must trigger on incomplete completion version (not isNewUser)');
  assert.doesNotMatch(enter, /data\.isNewUser\s*&&\s*!hasCompletedOnboarding/,
    'trigger must not be gated on isNewUser');
  assert.match(enter, /if\s*\(data\.isNewUser\)\s*\{\s*clearStoredInviteReferrerId\(\);/,
    'isNewUser must only drive invite-referrer cleanup');
  assert.match(maybeShow, /!hasCompletedOnboarding\(appState\.user\)/,
    'restore path must gate on completion version');
  assert.match(maybeShow, /appState\.onboardingActive\s*\|\|\s*appState\.guide\.teachingActive/,
    'restore trigger must not double-show while guide is active');
  const maybeCalls = (resolve.match(/maybeShowOnboardingAfterAuth\(\)/g) || []).length;
  assert.ok(maybeCalls >= 2, 'resolveStartupAuthentication must call the trigger on both profile-restore branches, got ' + maybeCalls);
}

function testAuthPageBehaviors() {
  // 6d — auth-page mascot behaviors.
  const bindings = extractNamedFunction(app, 'initMascotAuthBindings');
  const passwordExpr = extractNamedFunction(app, 'updateMascotPasswordExpression');
  const submit = extractNamedFunction(app, 'handleAuthSubmit');
  const pointError = extractNamedFunction(app, 'pointMascotAtAuthError');
  const pointField = extractNamedFunction(app, 'pointMascotAtAuthField');

  // Password focus → blink closed; no nagging while typing (blink only on
  // focus/input of the password field).
  assert.match(bindings, /password\.addEventListener\('focus',\s*updateMascotPasswordExpression\)/);
  assert.match(bindings, /password\.addEventListener\('blur',\s*updateMascotPasswordExpression\)/);
  assert.match(bindings, /password\.addEventListener\('input',\s*updateMascotPasswordExpression\)/);
  assert.match(passwordExpr, /if\s*\(closed\)\s*\{\s*mascot\.classList\.add\('is-blinking'\)/, 'password focus must blink the mascot closed');
  assert.doesNotMatch(bindings, /setMascotSpeech|setInterval|showAuthError/, 'auth bindings must not nag while typing');

  // Submit: the first invalid field gets the bounce — email is validated
  // before password; every validation failure surfaces via showAuthError.
  const emailCheck = submit.indexOf('isValidAuthEmail');
  const passwordCheck = submit.indexOf('needsPassword');
  assert.ok(emailCheck >= 0 && passwordCheck >= 0 && emailCheck < passwordCheck,
    'email validation must precede password validation in handleAuthSubmit');
  assert.match(submit, /showAuthError\(/, 'invalid submits must surface showAuthError');
  assert.match(submit, /hideAuthError\(\)/, 'valid submits must clear the error state');

  // Server-attributable errors map to fields; network errors never point.
  assert.match(pointError, /pointMascotAtAuthField\('authPassword'\)/, 'password errors must map to the password field');
  assert.match(pointError, /pointMascotAtAuthField\('authUsername'\)/, 'username errors must map to the username field');
  assert.match(pointError, /pointMascotAtAuthField\('authEmailCode'\)|pointMascotAtAuthField\('authTwoFactorCode'\)/, 'code errors must map to a code field');
  assert.match(pointError, /pointMascotAtAuthField\('authEmail'\)/, 'email errors must map to the email field');
  assert.match(pointError, /text\.includes\('network'\)|text\.includes\('网络'\)/, 'network errors must be detected');
  assert.match(pointError, /return;/, 'network errors must never point the mascot');
  assert.match(pointField, /bounceMascot\(\)/, 'pointing at a field must bounce the mascot');
}

function testGlobalHide() {
  // 6e — one visibility gate hides the mascot everywhere it can appear.
  const visibility = extractNamedFunction(app, 'syncGuideMascotVisibility');
  const hide = extractNamedFunction(app, 'hideMascot');

  assert.match(visibility, /if\s*\(!mascot\s*\|\|\s*!appState\.guide\.mascotEnabled\)\s*\{\s*hideMascot\(\);\s*return;\s*\}/,
    'disabled mascot must hide globally');
  assert.match(visibility, /'is-auth'/, 'visibility must manage the auth instance');
  assert.match(visibility, /'is-dwell'/, 'visibility must manage the dwell instance');
  assert.match(visibility, /'is-guide'/, 'visibility must manage the onboarding/guide instance');
  assert.match(hide, /setMascotSpeech\('',\s*''\)/, 'hide must clear speech for every instance');
}

function testMascotVisualGeometry() {
  const dwell = extractNamedFunction(app, 'positionDwellMascot');
  const obstacles = extractNamedFunction(app, 'getDwellMascotObstacles');
  const size = extractNamedFunction(app, 'getMascotSize');

  assert.match(index, /viewBox="0 0 160 160"/, 'mascot must use the compact 160px artboard');
  assert.match(index, /class="rai-mascot-planet"\s+cx="80"\s+cy="81"\s+r="50"/,
    'planet must fill enough of the compact artboard for its face to remain legible');
  assert.match(index, /class="rai-mascot-eye"[^>]+rx="14"\s+ry="17"/,
    'eyes must stay large enough to read at dwell size');
  assert.match(index, /class="rai-mascot-blush"/, 'mascot must retain its friendly cheek details');
  assert.match(index, /class="rai-mascot-tongue"/, 'mascot must retain its expressive smile detail');
  assert.match(size, /\?\s*48\s*:\s*58/, 'mascot must use the 48px mobile / 58px desktop sizes');
  assert.match(styles, /--rai-mascot-size:\s*58px/, 'desktop CSS mascot size must match JS geometry');
  assert.match(styles, /@media\s*\(max-width:\s*768px\)[\s\S]*?--rai-mascot-size:\s*48px/,
    'mobile CSS mascot size must match JS geometry');
  assert.doesNotMatch(styles, /\.rai-guide-mascot\s*\{\s*--rai-mascot-size:\s*42px/,
    'no late mobile rule may shrink the mascot back to 42px');
  assert.match(dwell, /composer\.right\s*\+\s*12/,
    'desktop dwell placement must prefer the outside-right composer edge');
  assert.match(obstacles, /'\.welcome-actions'/,
    'dwell placement must treat the welcome action rail as an obstacle');
  assert.match(dwell, /getDwellMascotObstacles\(\)/,
    'dwell placement must use the extended non-overlap obstacle set');
  assert.match(dwell, /classList\.toggle\('is-obscured',\s*!candidate\)/,
    'dwell mascot must hide instead of knowingly falling back onto an obstacle');
}

function testGuideLayoutAndDeviceSplit() {
  const welcomeCue = extractNamedFunction(app, 'setWelcomeMascotCue');
  const updateLayers = extractNamedFunction(app, 'updateGuideTargetLayers');
  const step = extractNamedFunction(app, 'setGuideTeachingStep');
  const copy = extractNamedFunction(app, 'getGuideStepCopy');
  const placement = extractNamedFunction(app, 'positionMascotAtRect');
  const speechSide = extractNamedFunction(app, 'syncMascotSpeechSide');
  const cleanup = extractNamedFunction(app, 'cleanupGuideTeaching');

  assert.match(styles, /\.onboarding-teaching-panel\s*\{[\s\S]*?display:\s*none;/,
    'teaching panel must not occupy welcome-card layout before teaching starts');
  assert.match(styles, /\.onboarding-teaching-panel\[hidden\]\s*\{\s*display:\s*none\s*!important;/,
    'hidden teaching panel must remain hidden despite later component rules');
  assert.match(styles, /\.onboarding-card\.guide-teaching\s*\{\s*display:\s*contents;/,
    'teaching controls must float independently instead of squeezing the center content');
  assert.match(styles, /\.onboarding-btn-skip\s*\{[\s\S]*?align-items:\s*center;[\s\S]*?justify-content:\s*center;/,
    'skip button label must be centered in both axes');
  assert.match(welcomeCue, /setGuideTarget\(target,\s*\{\s*focus:\s*false\s*\}\)/,
    'welcome buttons must not receive a second browser focus outline');
  assert.match(updateLayers, /getComputedStyle\(guideRuntime\.currentTarget\)\.borderRadius/,
    'tap-target ring must inherit the target control radius');
  assert.match(styles, /\.rai-guide-mask\s*\{[\s\S]*?z-index:\s*5100;/,
    'guide mask must stay above fixed menus');
  assert.match(styles, /\.rai-guide-ring\s*\{[\s\S]*?z-index:\s*5300;/,
    'guide ring must stay above fixed menus');
  assert.match(step, /step\s*===\s*'sidebar'\s*&&\s*isMobileGuideViewport\(\)/,
    'edge-swipe sidebar demo must run only on mobile viewports');
  assert.match(copy, /onb-guide-sidebar-desktop/,
    'desktop sidebar step must use desktop click copy instead of swipe copy');
  assert.match(step, /getDesktopSidebarGuideTarget\(\)/,
    'desktop sidebar step must target a desktop sidebar control');
  assert.match(placement, /top\s*<\s*getGuideViewportRect\(\)\.top\s*\+\s*8[\s\S]*?top\s*=\s*rect\.bottom\s*\+\s*12/,
    'mascot must move below top-edge controls instead of intercepting their clicks');
  assert.match(speechSide, /classList\.toggle\('speech-above',\s*!nearLeft\s*&&\s*!nearRight\)/,
    'centered mascot must place its speech directly above instead of clipping sideways');
  assert.match(styles, /\.rai-guide-mascot\.speech-above\s+\.rai-mascot-speech/,
    'centered speech layout must exist in CSS');
  assert.match(cleanup, /setMascotSpeech\('',\s*''\)/,
    'finishing the tour must clear the final teaching speech');
}

function testTeachingStepsNoAutoSelect() {
  // 6f — model/plus steps never auto-select anything.
  const step = extractNamedFunction(app, 'setGuideTeachingStep');

  assert.doesNotMatch(step, /selectedModel\s*=|selectModel|updateSelectedModelText|updateModelControls|dispatchEvent/,
    'teaching steps must never programmatically switch models or activate menu items');
  assert.match(step, /menu\.classList\.add\('rai-guide-readonly'\)/, 'plus step must apply the readonly guard');
  assert.match(styles, /\.more-menu\.rai-guide-readonly\s+\.more-menu-item\s*\{\s*pointer-events:\s*none;\s*\}/,
    'readonly guard must disable pointer events in CSS');
}

function testPwaSuppression() {
  // 6g — PWA reward prompt suppression (including R1 + R2).
  const prompt = extractNamedFunction(app, 'maybeShowPwaRewardPrompt');
  const onboarding = extractNamedFunction(app, 'showOnboarding');

  assert.match(prompt, /appState\.onboardingActive/, 'prompt must gate on onboardingActive');
  assert.match(prompt, /appState\.guide\.teachingActive/, 'prompt must gate on teachingActive');
  assert.match(prompt, /classList\.contains\('teaching'\)/, 'prompt must gate on the teaching overlay class');
  assert.match(prompt, /isVisibleElement\(onboardingOverlay\)/, 'prompt must gate on overlay visibility');
  assert.match(prompt, /requestAnimationFrame\(\(\)\s*=>\s*\{[\s\S]*?guideFlowActive[\s\S]*?overlay\.classList\.add\('active'\)/,
    'R1: the rAF activation must re-check the guide gate');
  assert.match(prompt, /closePwaRewardPrompt\(\);[\s\S]{0,120}return;\s*\}/,
    'the rAF re-check must close instead of activating while the guide flow runs');

  // R2: finish() re-triggers the prompt AFTER guide-flow flags are cleared.
  const finishBody = extractNestedFunction(onboarding, 'finish');
  const flagsCleared = finishBody.indexOf('appState.onboardingActive = false');
  const retrigger = finishBody.indexOf('maybeShowPwaRewardPrompt()');
  assert.ok(flagsCleared >= 0, 'finish() must clear onboardingActive');
  assert.ok(retrigger >= 0, 'R2: finish() must re-trigger maybeShowPwaRewardPrompt');
  assert.ok(retrigger > flagsCleared, 'R2: the re-trigger must run after the guide-flow flags are cleared');
  assert.ok(finishBody.indexOf('overlay.style.display = \'none\'') >= 0 && retrigger > finishBody.indexOf('overlay.style.display = \'none\''),
    'R2: the re-trigger must run after the welcome overlay is hidden');
}

function testReducedMotion() {
  // 6h — prefers-reduced-motion handling in JS + CSS animation cancellation.
  assert.match(app, /window\.matchMedia\?\.\('\(prefers-reduced-motion: reduce\)'\)/,
    'app must observe prefers-reduced-motion');
  assert.match(app, /guideRuntime\.reducedMotionQuery\s*=\s*query/, 'reduced-motion query must be retained');
  assert.match(app, /document\.documentElement\.classList\.toggle\('rai-reduced-motion',\s*guideRuntime\.reducedMotion\)/,
    'reduced-motion must be reflected on the root element');
  assert.match(styles, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?animation:\s*none\s*!important/,
    'CSS must cancel animations under reduced motion');
  assert.match(styles, /\.rai-guide-mascot\.is-guide-hop[\s\S]*?animation:\s*none\s*!important/,
    'mascot hops must be cancelled under reduced motion');
  assert.match(styles, /\.onboarding-overlay[\s\S]*?animation:\s*none\s*!important/,
    'onboarding overlay animations must be cancelled under reduced motion');
}

function testRemediationWiring() {
  // R3/R4/R5/R6 — the bounded remediation pass, asserted on stable semantics.
  const syncSide = extractNamedFunction(app, 'syncMascotSpeechSide');
  const hide = extractNamedFunction(app, 'hideMascot');
  const step = extractNamedFunction(app, 'setGuideTeachingStep');
  const sync = extractNamedFunction(app, 'syncGuideStateToServer');
  const mascotFn = extractNamedFunction(app, 'applyGuideMascotState');
  const tapFn = extractNamedFunction(app, 'applyGuideTapTargetState');
  const onboarding = extractNamedFunction(app, 'showOnboarding');

  // R3: speech-side helper flips the bubble when the mascot sits near the left
  // edge, applied at the sidebar demo / "your turn" call sites.
  assert.match(syncSide, /const\s+nearLeft\s*=\s*left\s*<\s*viewportWidth\s*\*\s*0\.3[\s\S]*?classList\.toggle\('speech-right',\s*nearLeft\)/,
    'R3: speech-right must flip when the mascot is left of 30% of the viewport');
  assert.match(app, /syncMascotSpeechSide\(\);\s*\}/, 'R3: helper must be invoked at the mascot placement sites');
  assert.match(hide, /'speech-right'/, 'R3: hideMascot must clear the flipped side');
  assert.match(styles, /\.rai-guide-mascot\.speech-right\s+\.rai-mascot-speech/, 'R3: the speech-right CSS rule must exist');

  // R4: model step holds the dropdown open (~1200ms) before advancing.
  assert.match(step, /setGuideTeachingStep\('plus'\);\s*\},\s*1200\);/, 'R4: model step must advance after 1200ms');
  assert.doesNotMatch(step, /setGuideTeachingStep\('plus'\);\s*\},\s*80\);/, 'R4: the 80ms flicker must be gone');

  // R5: per-field sync outcomes; each caller rolls back only its own field.
  assert.match(sync, /return\s*\{\s*ok:\s*failedFields\.length\s*===\s*0,\s*failedFields\s*\}/,
    'R5: syncGuideStateToServer must resolve {ok, failedFields}');
  assert.match(sync, /failedFields\.push\(\.\.\.Object\.keys\(nextPatch\)\)/, 'R5: failed fields must be recorded per patch');
  assert.match(mascotFn, /failedFields\.includes\('mascotEnabled'\)/, 'R5: mascot must roll back only its own field');
  assert.match(tapFn, /failedFields\.includes\('tapTargetEnabled'\)/, 'R5: tap target must roll back only its own field');

  // R6: stale timers cleared at showOnboarding entry (replay mid-teaching).
  assert.match(onboarding, /initGuideRuntime\(\);\s*[\s\S]*?clearGuideTimers\(\);\s*[\s\S]*?onboardingEventController\?\.abort\(\);/,
    'R6: showOnboarding must clear guide timers on entry');
}

function testMobileGuideCollisionAvoidance() {
  const panel = extractNamedFunction(app, 'updateGuideTeachingPanel');
  const position = extractNamedFunction(app, 'positionMascotAtRect');
  const move = extractNamedFunction(app, 'moveMascotToElement');
  const step = extractNamedFunction(app, 'setGuideTeachingStep');
  const begin = extractNamedFunction(app, 'beginGuideTeaching');
  const cleanup = extractNamedFunction(app, 'cleanupGuideTeaching');
  const floatingMenu = extractNamedFunction(app, 'positionFloatingMenu');

  assert.match(panel, /const\s+mobile\s*=\s*isMobileGuideViewport\(\)/,
    'mobile teaching must use an explicit layout branch');
  assert.match(panel, /panel\.hidden\s*=\s*appState\.guide\.mascotEnabled\s*&&\s*!mobile/,
    'mobile teaching must keep the standalone teaching panel visible');
  assert.match(move, /guideRuntime\.teachingActive\s*&&\s*isMobileGuideViewport\(\)/,
    'mobile teaching must suppress the mascot speech bubble');
  assert.match(position, /rectsOverlap\(proposed,\s*panelRect,\s*10\)[\s\S]*?panelRect\.bottom\s*\+\s*10/,
    'mobile mascot placement must avoid the teaching panel');
  assert.match(step, /isMobileGuideViewport\(\)[\s\S]*?classList\.add\('is-menu-preview-hidden'\)[\s\S]*?setMascotSpeech\('',\s*''\)/,
    'mobile plus-menu preview must hide the mascot and its speech instead of covering menu controls');
  assert.match(cleanup, /'is-menu-preview-hidden'/,
    'guide cleanup must restore a mascot hidden for menu preview');
  assert.match(begin, /document\.body\.classList\.add\('rai-guide-teaching-active'\)/,
    'teaching must expose a body-level layout state');
  assert.match(cleanup, /document\.body\.classList\.remove\('rai-guide-teaching-active'\)/,
    'guide cleanup must clear the body-level layout state');
  assert.match(floatingMenu, /guideRuntime\.teachingActive\s*&&\s*isMobileGuideViewport\(\)[\s\S]*?guidePanelRect\.bottom\s*\+\s*12/,
    'mobile composer menus must reserve the teaching panel as a hard top boundary');
  assert.match(styles, /@media\s*\(max-width:\s*768px\)[\s\S]*?\.onboarding-card\.guide-teaching\s+\.onboarding-teaching-panel\s*\{[\s\S]*?top:\s*max\(72px,[\s\S]*?width:\s*calc\(100vw\s*-\s*24px\)/,
    'mobile teaching panel must occupy its own full-width row below the top controls');
  assert.match(styles, /\.rai-guide-mascot\.is-guide\s+\.rai-mascot-speech\s*\{\s*display:\s*none\s*!important;/,
    'mobile teaching CSS must fail closed if stale speech content remains');
  assert.match(styles, /body\.rai-guide-teaching-active\s+\.welcome-actions\s*\{\s*visibility:\s*hidden;/,
    'mobile teaching must remove inactive welcome shortcuts from the mascot path');
}

function testPetSelectionAndInteraction() {
  assert.ok(fs.existsSync(teaPetAsset), 'Tea pet WebP asset must exist');
  assert.ok(fs.statSync(teaPetAsset).size > 1000 && fs.statSync(teaPetAsset).size < 200000,
    'Tea pet WebP must be non-empty and lightweight');
  assert.match(index, /id="settingsPetPicker"[\s\S]*?data-pet-type="saturn"[\s\S]*?data-pet-type="tea"/,
    'settings must expose Saturn and Tea pet choices');
  assert.match(index, /id="raiPetContextMenu"[\s\S]*?id="raiPetHideAction"/,
    'pet context menu must expose a hide action');
  assert.match(styles, /images\/pets\/tea-pet\.webp/, 'Tea pet asset must be rendered by CSS');
  assert.match(app, /const\s+RAI_PET_TYPES\s*=\s*new Set\(\['saturn',\s*'tea'\]\)/,
    'client pet type allowlist must be strict');
  assert.match(app, /RAI_PET_POSITION_PREFIX\s*=\s*'rai_pet_position:'/, 'pet positions must use an account-scoped prefix');
  assert.match(app, /Math\.hypot\([\s\S]*?<\s*7/, 'drag must use a movement threshold');
  assert.match(app, /setPointerCapture/, 'drag must capture the pointer');
  assert.match(app, /guideRuntime\.suppressPetClick\s*=\s*true/, 'drag must suppress the release click');
  assert.match(app, /addEventListener\('contextmenu'/, 'desktop context menu must be bound');
  assert.match(app, /any-hover:\s*hover[\s\S]*?any-pointer:\s*fine/, 'right-click menu must be limited to desktop-like pointers');
  assert.match(app, /applyGuideMascotState\(false\)/, 'context-menu hide must use the shared server-backed setting path');
  assert.match(app, /event\.key\s*===\s*'Escape'[\s\S]*?closePetContextMenu/, 'Escape must close the context menu');
  assert.match(app, /shouldDefaultHidePet\s*=\s*!isGuideCompleted/, 'only first completion should default-hide the pet');
  assert.match(app, /disableMascot:\s*shouldDefaultHidePet/, 'finish and skip must persist the first-run hide state');
  assert.match(app, /pet-hidden-after-guide/, 'the post-guide Settings notice must exist');
}

// ---------------------------------------------------------------------------
// Runtime helpers (beta-isolated-api-regression style)
// ---------------------------------------------------------------------------

function listen(server, host = '127.0.0.1', port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server.address());
    });
  });
}

function closeServer(server) {
  if (!server || !server.listening) return Promise.resolve();
  if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    server.close(finish);
    const timer = setTimeout(() => {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      finish();
    }, 2000);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

async function reservePort() {
  const server = http.createServer((_req, res) => res.end());
  const address = await listen(server);
  await closeServer(server);
  return address.port;
}

function readRequestJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error('fake email request too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

// Fake RESEND_API_URL loopback server. A dead port here makes registration
// fail, so the fake service must be up before the application starts.
async function createFakeEmailService() {
  const messages = [];
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'POST' && req.url === '/emails') {
        const payload = await readRequestJson(req);
        messages.push({ receivedAt: Date.now(), payload });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: `onboarding-mail-${messages.length}` }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'fake_route_not_found' }));
    } catch (error) {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'fake_service_error' }));
    }
  });
  const address = await listen(server);
  const origin = `http://127.0.0.1:${address.port}`;

  // {6,32}: this build's verification codes are exactly 6 digits.
  async function waitForCode(email, subjectHint = '', timeoutMs = 6000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const payload = messages[index].payload || {};
        const recipients = Array.isArray(payload.to) ? payload.to : [payload.to];
        if (!recipients.map(String).includes(email)) continue;
        if (subjectHint && !String(payload.subject || '').includes(subjectHint)) continue;
        const text = String(payload.text || '');
        const match = text.match(/验证码\s*[:：]\s*([^\s]{6,32})/);
        if (match) return match[1];
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error(`fake mail code not captured for ${email}`);
  }

  return { server, origin, messages, waitForCode };
}

function writeLoopbackNetworkGuard(tempRoot) {
  const guardPath = path.join(tempRoot, 'onboarding-loopback-network-guard.cjs');
  const source = `
'use strict';

const http = require('http');
const https = require('https');

function isLoopbackHostname(value) {
  const hostname = String(value || '').replace(/^\\[|\\]$/g, '').toLowerCase();
  return hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost';
}

function assertLoopbackTarget(value) {
  const url = value instanceof URL ? value : new URL(String(value));
  if ((url.protocol === 'http:' || url.protocol === 'https:') && !isLoopbackHostname(url.hostname)) {
    const error = new Error('audit_external_network_blocked');
    error.code = 'AUDIT_EXTERNAL_NETWORK_BLOCKED';
    throw error;
  }
  return url;
}

if (typeof globalThis.fetch === 'function') {
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = function guardedFetch(resource, init) {
    const raw = typeof resource === 'string' || resource instanceof URL ? resource : resource?.url;
    if (raw) assertLoopbackTarget(raw);
    return nativeFetch(resource, init);
  };
}

for (const moduleRef of [http, https]) {
  const nativeRequest = moduleRef.request.bind(moduleRef);
  moduleRef.request = function guardedRequest(input, options, callback) {
    let target = null;
    if (typeof input === 'string' || input instanceof URL) {
      target = input;
    } else if (input && typeof input === 'object') {
      const protocol = input.protocol || (moduleRef === https ? 'https:' : 'http:');
      const hostname = input.hostname || input.host || 'localhost';
      target = \`\${protocol}//\${hostname}\${input.path || '/'}\`;
    } else if (options && typeof options === 'object') {
      const protocol = options.protocol || (moduleRef === https ? 'https:' : 'http:');
      const hostname = options.hostname || options.host || 'localhost';
      target = \`\${protocol}//\${hostname}\${options.path || '/'}\`;
    }
    if (target) assertLoopbackTarget(target);
    return nativeRequest(input, options, callback);
  };
  moduleRef.get = function guardedGet(input, options, callback) {
    const request = moduleRef.request(input, options, callback);
    request.end();
    return request;
  };
}
`;
  fs.writeFileSync(guardPath, source, { mode: 0o600 });
  return guardPath;
}

function openDb(dbPath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, (error) => {
      if (error) {
        db.close(() => reject(error));
        return;
      }
      try {
        db.configure('busyTimeout', 30000);
      } catch (configureError) {
        db.close(() => reject(configureError));
        return;
      }
      db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 30000;', (pragmaError) => {
        if (!pragmaError) {
          resolve(db);
          return;
        }
        db.close(() => reject(pragmaError));
      });
    });
  });
}

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows));
  });
}

function dbClose(db) {
  return new Promise((resolve) => db.close(() => resolve()));
}

async function withDb(dbPath, callback) {
  const db = await openDb(dbPath);
  try {
    return await callback(db);
  } finally {
    await dbClose(db);
  }
}

function appendCapped(current, chunk, limit = 1024 * 1024) {
  const next = current + chunk.toString('utf8');
  return next.length > limit ? next.slice(next.length - limit) : next;
}

function sanitizeLog(text) {
  return String(text || '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/验证码\s*[:：]\s*[^\s]+/g, '验证码: [redacted]')
    .replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g, '[redacted-jwt]');
}

function startApplication({ tempRoot, dbPath, uploadsDir, avatarsDir, fakeOrigin, port, jwtSecret }) {
  const networkGuardPath = writeLoopbackNetworkGuard(tempRoot);
  const conversationSigningKeyPath = path.join(tempRoot, 'onboarding-conversation-ed25519.pem');
  if (!fs.existsSync(conversationSigningKeyPath)) {
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(conversationSigningKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  }
  const conversationLedgerDir = path.join(tempRoot, 'onboarding-conversation-ledger');
  const conversationMirrorDir = path.join(tempRoot, 'onboarding-conversation-mirror');
  fs.mkdirSync(conversationMirrorDir, { recursive: true, mode: 0o700 });
  const env = {
    PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: tempRoot,
    TMPDIR: tempRoot,
    LANG: process.env.LANG || 'en_US.UTF-8',
    LC_ALL: process.env.LC_ALL || '',
    TZ: process.env.TZ || 'UTC',
    NO_PROXY: '127.0.0.1,localhost,::1',
    no_proxy: '127.0.0.1,localhost,::1',
    NODE_OPTIONS: `--require=${networkGuardPath}`,
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    BIND_HOST: '127.0.0.1',
    PORT: String(port),
    TRUST_PROXY: '1',
    PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
    CORS_ORIGINS: `http://127.0.0.1:${port}`,
    RAI_DB_PATH: dbPath,
    RAI_UPLOAD_DIR: uploadsDir,
    RAI_AVATAR_DIR: avatarsDir,
    RAI_RUNTIME_REPORT_PATH: path.join(tempRoot, 'onboarding-runtime-report.md'),
    RAI_CONVERSATION_SIGNING_PRIVATE_KEY_FILE: conversationSigningKeyPath,
    RAI_CONVERSATION_INTEGRITY_ISSUER: `http://127.0.0.1:${port}`,
    RAI_CONVERSATION_LEDGER_DIR: conversationLedgerDir,
    RAI_CONVERSATION_LEDGER_MIRROR_DIR: conversationMirrorDir,
    JWT_SECRET: jwtSecret,
    ADMIN_USERNAME: 'audit-admin',
    ADMIN_PASSWORD_HASH: bcrypt.hashSync('Onboarding-Admin-123456', 10),
    ADMIN_JWT_SECRET: crypto.randomBytes(48).toString('hex'),
    RAI_ADMIN_TOTP_REQUIRED: 'false',
    RESEND_API_KEY: 'onboarding-resend-key-never-leaves-loopback',
    RESEND_FROM_EMAIL: 'RAI Onboarding Audit <onboarding@local.test>',
    RESEND_API_URL: `${fakeOrigin}/emails`,
    RAI_RESEND_TIMEOUT_MS: '3000',
    RAI_ALLOW_RESEND_TEST_MODE_EMAIL_BYPASS: 'false',
    OPENROUTER_API_KEY: '',
    OPENROUTER_BASE_URL: `http://127.0.0.1:${port}/provider`,
    OPENROUTER_HTTP_REFERER: `http://127.0.0.1:${port}`,
    OPENROUTER_APP_TITLE: 'RAI Onboarding Audit',
    GOOGLE_GEMINI_API_KEY: '',
    GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${port}/provider`,
    SILICONFLOW_API_KEY: '',
    SILICONFLOW_IMAGE_GENERATION_URL: `http://127.0.0.1:${port}/provider`,
    DEEPSEEK_API_KEY: '',
    ALIYUN_API_KEY: '',
    POE_API_KEY: '',
    TAVILY_API_KEY: '',
    NVIDIA_API_KEY: '',
    NEW_GOOGLE_API_KEY: '',
    ZTX6D_APP_ID: '',
    ZTX6D_APP_KEY: '',
    ZTX6D_API_URL: `http://127.0.0.1:${port}/ztx6d`,
    ZTX6D_LOGIN_URL: `http://127.0.0.1:${port}/ztx6d-login`,
    ZTX6D_CALLBACK_URL: `http://127.0.0.1:${port}/api/auth/ztx6d/callback`,
    ZTX6D_FORCE_DISABLED: 'true',
    RAI_ZTX6D_FORCE_DISABLED: 'true',
    RAI_DEFAULT_DISABLED_MODELS: '',
    RAI_CHAT_QUOTA_PER_MINUTE: '1000',
    RAI_CHAT_QUOTA_PER_5H: '10000',
    RAI_CHAT_QUOTA_PER_WEEK: '10000',
    RAI_UPLOAD_USER_TOTAL_MB: '256',
    RAI_UPLOAD_USER_MAX_FILES: '1000',
    RAI_MAX_CONCURRENT_REQUESTS_FREE: '100',
    RAI_MAX_CONCURRENT_REQUESTS_PRO_MAX: '100'
  };
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false
  });
  const state = { stdout: '', stderr: '', exit: null };
  child.stdout.on('data', (chunk) => { state.stdout = appendCapped(state.stdout, chunk); });
  child.stderr.on('data', (chunk) => { state.stderr = appendCapped(state.stderr, chunk); });
  child.on('exit', (code, signal) => { state.exit = { code, signal }; });
  return { child, state, baseUrl: `http://127.0.0.1:${port}` };
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const waitForExit = (timeoutMs) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true);
      return;
    }
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
  });
  child.kill('SIGTERM');
  const exited = await waitForExit(3000);
  if (!exited && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await waitForExit(3000);
  }
}

async function apiRequest(baseUrl, routePath, options = {}) {
  const method = options.method || 'GET';
  const timeoutMs = options.timeoutMs || REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { Accept: 'application/json', ...(options.headers || {}) };
  if (options.ip) headers['X-Forwarded-For'] = options.ip;
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const requestOptions = {
    method,
    headers,
    signal: controller.signal
  };
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    requestOptions.body = JSON.stringify(options.body);
  }
  try {
    const response = await fetch(`${baseUrl}${routePath}`, requestOptions);
    const text = await response.text();
    let body = text;
    try { body = text ? JSON.parse(text) : null; } catch (_error) { /* keep text */ }
    return { status: response.status, headers: response.headers, body, text };
  } finally {
    clearTimeout(timeout);
  }
}

// Readiness == the server answers AND the guide migrations are complete on the
// target DB (the three guide columns exist with the right defaults).
async function waitForReady(baseUrl, dbPath, childState, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (childState.exit) {
      throw new Error(`onboarding child exited early: ${JSON.stringify(childState.exit)}\n${sanitizeLog(childState.stderr)}`);
    }
    try {
      const version = await apiRequest(baseUrl, '/api/version', { timeoutMs: 1000 });
      if (version.status === 200 && fs.existsSync(dbPath)) {
        const schemaReady = await withDb(dbPath, async (db) => {
          const columns = await dbAll(db, 'PRAGMA table_info(user_configs)');
          const names = new Set(columns.map((column) => column.name));
          return names.has('guide_mascot_enabled')
            && names.has('guide_pet_type')
            && names.has('guide_tap_target_enabled')
            && names.has('onboarding_completed_version');
        });
        if (schemaReady) return version.body;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`onboarding server readiness timeout: ${lastError?.message || 'unknown'}\nstdout:\n${sanitizeLog(childState.stdout)}\nstderr:\n${sanitizeLog(childState.stderr)}`);
}

let ipCounter = 10;

function nextAuditIp() {
  ipCounter += 1;
  return `203.0.113.${ipCounter % 250}`;
}

async function createVerifiedUser(context, label) {
  const email = `codex-onboarding-${label}-${RUN_ID}@local.test`;
  const password = TEST_PASSWORD;
  const register = await apiRequest(context.baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { email, password, username: `Onboarding ${label}` },
    ip: nextAuditIp()
  });
  assert.equal(register.status, 200, `register ${label}: ${register.text}`);
  assert.equal(register.body?.requiresEmailVerification, true, `register ${label} must use fake email verification`);
  const code = await context.fake.waitForCode(email, '注册');
  const verify = await apiRequest(context.baseUrl, '/api/auth/register/verify', {
    method: 'POST',
    body: { email, code, fingerprint: `onboarding-${label}` },
    ip: nextAuditIp()
  });
  assert.equal(verify.status, 200, `verify ${label}: ${verify.text}`);
  assert.ok(verify.body?.token, `verify ${label} must return a token`);
  assert.ok(verify.body?.user?.id, `verify ${label} must return a user id`);
  return { email, password, token: verify.body.token, id: Number(verify.body.user.id) };
}

async function loginUser(context, email, password) {
  const login = await apiRequest(context.baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email, password, fingerprint: `onboarding-relogin-${RUN_ID}` },
    ip: nextAuditIp()
  });
  assert.equal(login.status, 200, `login: ${login.text}`);
  assert.ok(login.body?.token, 'login must return a token');
  return login.body.token;
}

// ---------------------------------------------------------------------------
// Runtime tests (mirrors the product test plan items 1-5)
// ---------------------------------------------------------------------------

async function assertGuideSchema(dbPath) {
  return withDb(dbPath, async (db) => {
    const columns = await dbAll(db, 'PRAGMA table_info(user_configs)');
    const byName = Object.fromEntries(columns.map((column) => [column.name, column]));
    const guideColumns = {
      guide_mascot_enabled: '1',
      guide_tap_target_enabled: '1',
      onboarding_completed_version: '0'
    };
    for (const [name, expectedDefault] of Object.entries(guideColumns)) {
      const column = byName[name];
      assert.ok(column, `user_configs must have ${name}`);
      assert.equal(column.type, 'INTEGER', `${name} must be INTEGER`);
      assert.equal(String(column.dflt_value), expectedDefault, `${name} default must be ${expectedDefault}`);
    }
    const petType = byName.guide_pet_type;
    assert.ok(petType, 'user_configs must have guide_pet_type');
    assert.equal(petType.type, 'TEXT', 'guide_pet_type must be TEXT');
    assert.equal(String(petType.dflt_value), "'saturn'", 'guide_pet_type default must be saturn');
    return columns;
  });
}

async function testMigrationIdempotencyAndSchema(context, bootLogs) {
  // Plan item 1 + 2: second boot on the same DB must not crash and must not
  // log a duplicate-column failure; schema must carry the three guide columns.
  assert.ok(!context.childState.exit, 'second boot child must stay alive');
  const combinedLogs = sanitizeLog(`${context.childState.stdout}\n${context.childState.stderr}`);
  assert.doesNotMatch(combinedLogs, /duplicate column/i,
    'second boot must not log duplicate-column failures');
  await assertGuideSchema(context.dbPath);
  return { secondBootLogLines: combinedLogs.split('\n').length };
}

async function testFreshUserProfileDefaults(context, user) {
  // Plan item 3: fresh verified user profile defaults.
  const profile = await apiRequest(context.baseUrl, '/api/user/profile', { token: user.token, ip: nextAuditIp() });
  assert.equal(profile.status, 200, `fresh profile: ${profile.text}`);
  assert.equal(profile.body?.guideMascotEnabled, true, 'fresh user guideMascotEnabled must be true');
  assert.equal(profile.body?.guidePetType, 'saturn', 'fresh user guidePetType must be saturn');
  assert.equal(profile.body?.guideTapTargetEnabled, true, 'fresh user guideTapTargetEnabled must be true');
  assert.equal(Number(profile.body?.onboardingCompletedVersion), 0, 'fresh user onboardingCompletedVersion must be 0');
}

async function testGuideStatePatchMatrix(context, user) {
  // Plan item 4: the P1 smoke matrix.
  const patch = async (body, token = user.token) => (
    apiRequest(context.baseUrl, '/api/user/guide-state', {
      method: 'PATCH',
      body,
      token,
      ip: nextAuditIp()
    })
  );

  // {completedVersion:1} → 200 + read-back 1 + profile reflects.
  const complete = await patch({ completedVersion: 1 });
  assert.equal(complete.status, 200, `completedVersion:1: ${complete.text}`);
  assert.equal(Number(complete.body?.onboardingCompletedVersion), 1, 'patch must return completedVersion 1');
  const profileAfterComplete = await apiRequest(context.baseUrl, '/api/user/profile', { token: user.token, ip: nextAuditIp() });
  assert.equal(profileAfterComplete.status, 200, `profile read-back: ${profileAfterComplete.text}`);
  assert.equal(Number(profileAfterComplete.body?.onboardingCompletedVersion), 1, 'profile must reflect completedVersion 1');

  // {mascotEnabled:false} → 200 partial (tap target untouched).
  const mascotOff = await patch({ mascotEnabled: false });
  assert.equal(mascotOff.status, 200, `mascotEnabled:false: ${mascotOff.text}`);
  assert.equal(mascotOff.body?.guideMascotEnabled, false, 'patch must return mascot disabled');
  assert.equal(mascotOff.body?.guideTapTargetEnabled, true, 'partial patch must leave tap target untouched');

  const teaSelected = await patch({ petType: 'tea' });
  assert.equal(teaSelected.status, 200, `petType:tea: ${teaSelected.text}`);
  assert.equal(teaSelected.body?.guidePetType, 'tea', 'Tea selection must persist');
  const saturnSelected = await patch({ petType: 'saturn' });
  assert.equal(saturnSelected.status, 200, `petType:saturn: ${saturnSelected.text}`);
  assert.equal(saturnSelected.body?.guidePetType, 'saturn', 'Saturn selection must persist');
  const invalidPet = await patch({ petType: 'mars' });
  assert.equal(invalidPet.status, 400, 'unknown pet types must be rejected');

  // Validation matrix.
  const completedVersionTwo = await patch({ completedVersion: 2 });
  assert.equal(completedVersionTwo.status, 400, 'completedVersion:2 must be rejected');
  const mascotString = await patch({ mascotEnabled: 'yes' });
  assert.equal(mascotString.status, 400, 'mascotEnabled:"yes" must be rejected');
  const tapTargetNumber = await patch({ tapTargetEnabled: 1 });
  assert.equal(tapTargetNumber.status, 400, 'tapTargetEnabled:1 must be rejected');
  const empty = await patch({});
  assert.equal(empty.status, 400, '{} must be rejected');
  // Unknown fields mixed with a valid known field are ignored (the server's
  // 400 for a patch with NO known fields is the same guard as {}→400).
  const unknownField = await patch({ completedVersion: 1, someUnknownField: 'ignored' });
  assert.equal(unknownField.status, 200, 'unknown fields must be ignored alongside a valid field');
  assert.equal(Number(unknownField.body?.onboardingCompletedVersion), 1, 'known field must still apply');
  assert.equal(unknownField.body?.guideMascotEnabled, false, 'unknown-field patch must not change other state');

  // Unauthenticated.
  const unauthenticated = await patch({ mascotEnabled: true }, '');
  assert.equal(unauthenticated.status, 401, 'unauthenticated patch must be rejected');
}

async function testCompletionVersionPersistenceAcrossLogin(context, user) {
  // Plan item 5: 跨登录持久化 — a NEW token from the login endpoint still
  // sees the completed version (server-side proof, no client mirror involved).
  const nextToken = await loginUser(context, user.email, user.password);
  assert.notEqual(nextToken, user.token, 'relogin must issue a fresh token');
  const profile = await apiRequest(context.baseUrl, '/api/user/profile', { token: nextToken, ip: nextAuditIp() });
  assert.equal(profile.status, 200, `relogin profile: ${profile.text}`);
  assert.equal(Number(profile.body?.onboardingCompletedVersion), 1, 'completedVersion must persist across login sessions');
  assert.equal(profile.body?.guideMascotEnabled, false, 'guide toggle state must persist across login sessions');
  assert.equal(profile.body?.guideTapTargetEnabled, true, 'tap target must stay untouched across login sessions');
}

async function runStaticTests() {
  return [
    { name: 'static:version-constants', run: testVersionConstants },
    { name: 'static:guide-wiring', run: testGuideWiring },
    { name: 'static:completion-version-recording', run: testCompletionVersionRecording },
    { name: 'static:legacy-completion-account-isolation', run: testLegacyCompletionAccountIsolation },
    { name: 'static:registration-language-prompt-removed', run: testRegistrationLanguagePromptRemoved },
    { name: 'static:guide-trigger-paths', run: testGuideTriggerPaths },
    { name: 'static:auth-page-behaviors', run: testAuthPageBehaviors },
    { name: 'static:global-hide', run: testGlobalHide },
    { name: 'static:mascot-visual-geometry', run: testMascotVisualGeometry },
    { name: 'static:guide-layout-and-device-split', run: testGuideLayoutAndDeviceSplit },
    { name: 'static:teaching-steps-no-auto-select', run: testTeachingStepsNoAutoSelect },
    { name: 'static:pwa-suppression-r1-r2', run: testPwaSuppression },
    { name: 'static:reduced-motion', run: testReducedMotion },
    { name: 'static:remediation-wiring-r3-r4-r5-r6', run: testRemediationWiring },
    { name: 'static:mobile-guide-collision-avoidance', run: testMobileGuideCollisionAvoidance },
    { name: 'static:pet-selection-drag-context-hide', run: testPetSelectionAndInteraction }
  ].map(({ name, run }) => ({ name, run }));
}

async function runRuntimeTests(context, user) {
  return [
    { name: 'runtime:migration-idempotency-and-schema', run: () => testMigrationIdempotencyAndSchema(context) },
    { name: 'runtime:fresh-user-profile-defaults', run: () => testFreshUserProfileDefaults(context, user) },
    { name: 'runtime:guide-state-patch-matrix', run: () => testGuideStatePatchMatrix(context, user) },
    { name: 'runtime:completion-version-cross-login-persistence', run: () => testCompletionVersionPersistenceAcrossLogin(context, user) }
  ];
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rai-onboarding-guide-'));
  const dbPath = path.join(tempRoot, 'onboarding-audit.sqlite3');
  const uploadsDir = path.join(tempRoot, 'uploads-onboarding');
  const avatarsDir = path.join(tempRoot, 'avatars-onboarding');
  const jwtSecret = crypto.randomBytes(48).toString('hex');
  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.mkdirSync(avatarsDir, { recursive: true });

  let fake = null;
  let application = null;
  const results = [];
  let executionError = null;
  const cleanupErrors = [];
  try {
    fake = await createFakeEmailService();
    const port = await reservePort();
    const start = async () => startApplication({ tempRoot, dbPath, uploadsDir, avatarsDir, fakeOrigin: fake.origin, port, jwtSecret });

    // Boot #1 on the fresh DB.
    application = await start();
    await waitForReady(application.baseUrl, dbPath, application.state);

    // Boot #2 on the SAME DB (migration idempotency).
    await stopChild(application.child);
    application = await start();
    await waitForReady(application.baseUrl, dbPath, application.state);

    const context = {
      baseUrl: application.baseUrl,
      dbPath,
      childState: application.state,
      fake
    };

    const user = await createVerifiedUser(context, 'audit');

    const staticTests = await runStaticTests();
    const runtimeTests = await runRuntimeTests(context, user);
    const tests = [...staticTests, ...runtimeTests];
    for (const test of tests) {
      try {
        await test.run();
        results.push({ name: test.name, status: 'passed' });
        console.log(`PASS ${test.name}`);
      } catch (error) {
        results.push({ name: test.name, status: 'failed', error: `${error.message || error}` });
        console.log(`FAIL ${test.name} :: ${error.message || error}`);
      }
    }
  } catch (error) {
    executionError = error;
  } finally {
    try {
      await stopChild(application?.child);
    } catch (error) {
      cleanupErrors.push(new Error(`child cleanup failed: ${error.message}`));
    }
    try {
      if (fake?.server) await closeServer(fake.server);
    } catch (error) {
      cleanupErrors.push(new Error(`fake email cleanup failed: ${error.message}`));
    }
    if (path.dirname(tempRoot) === os.tmpdir() && /^rai-onboarding-guide-/.test(path.basename(tempRoot))) {
      try {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(new Error(`temp root cleanup failed: ${error.message}`));
      }
    } else {
      cleanupErrors.push(new Error(`refusing to remove unexpected temp root: ${tempRoot}`));
    }
  }

  if (executionError) {
    if (cleanupErrors.length > 0) executionError.cleanupErrors = cleanupErrors.map((error) => error.message);
    throw executionError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'onboarding guide regression cleanup failed');
  }

  const failures = results.filter((item) => item.status === 'failed');
  console.log(`ONBOARDING_GUIDE_TESTS=${results.length}`);
  console.log(`ONBOARDING_GUIDE_PASSED=${results.length - failures.length}`);
  console.log(`ONBOARDING_GUIDE_FAILED=${failures.length}`);
  if (failures.length > 0) {
    for (const failure of failures) console.log(`FAILED_CASE=${failure.name} :: ${failure.error}`);
    process.exitCode = 1;
    return;
  }
  console.log('onboarding-guide-regression ok');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`onboarding-guide-regression failed: ${sanitizeLog(error.stack || error.message)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  GUIDE_VERSION,
  extractNamedFunction,
  extractBracedBlock,
  testVersionConstants,
  testGuideWiring,
  testCompletionVersionRecording,
  testAuthPageBehaviors,
  testGlobalHide,
  testMascotVisualGeometry,
  testGuideLayoutAndDeviceSplit,
  testTeachingStepsNoAutoSelect,
  testPwaSuppression,
  testReducedMotion,
  testRemediationWiring,
  testMobileGuideCollisionAvoidance,
  assertGuideSchema,
  writeLoopbackNetworkGuard
};
