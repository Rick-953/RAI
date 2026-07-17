#!/usr/bin/env node

'use strict';

const assert = require('assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');

const ROOT = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
const exists = (relativePath) => fs.existsSync(path.join(ROOT, relativePath));

const packageJson = JSON.parse(read('package.json'));
const server = read('server.js');
const app = read('public/app.js');
const index = read('public/index.html');
const styles = read('public/styles.css');
const serviceWorker = read('public/sw.js');
const explainerPath = 'public/selection-explainer.js';
const explainerStylesPath = 'public/selection-explainer.css';
const explainer = exists(explainerPath) ? read(explainerPath) : '';
const explainerStyles = exists(explainerStylesPath) ? read(explainerStylesPath) : '';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Route bodies are bounded by the next top-level Express registration. This is a
// source-surface check, not a JavaScript brace parser; large functions may contain
// template literals and nested braces that make ad-hoc brace counting unreliable.
function routeSurface(method, routePath) {
  const pattern = new RegExp(`app\\.${method}\\(\\s*['"]${escapeRegExp(routePath)}['"]`);
  const match = pattern.exec(server);
  assert.ok(match, `missing ${method.toUpperCase()} ${routePath}`);
  const remainder = server.slice(match.index + match[0].length);
  const nextRoute = /\napp\.(?:get|post|put|patch|delete)\s*\(/.exec(remainder);
  return server.slice(match.index, nextRoute ? match.index + match[0].length + nextRoute.index : server.length);
}

function assertContainsAll(source, needles, label) {
  for (const needle of needles) {
    assert.ok(source.includes(needle), `${label} must contain ${JSON.stringify(needle)}`);
  }
}

function sourceBetween(source, startToken, endToken, label) {
  const start = source.indexOf(startToken);
  assert.ok(start >= 0, `missing ${label || startToken}`);
  const end = source.indexOf(endToken, start + startToken.length);
  assert.ok(end > start, `missing end of ${label || startToken}`);
  return source.slice(start, end);
}

function sqliteExec(db, sql) {
  return new Promise((resolve, reject) => {
    db.exec(sql, (error) => (error ? reject(error) : resolve()));
  });
}

function sqliteGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => (error ? reject(error) : resolve(row)));
  });
}

function sqliteAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => (error ? reject(error) : resolve(rows || [])));
  });
}

function sqliteRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) reject(error);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function sqliteClose(db) {
  return new Promise((resolve, reject) => {
    db.close((error) => (error ? reject(error) : resolve()));
  });
}

function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

function waitForChildExit(child, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, new Error(`temporary invalid-schema server did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('error', (error) => finish(reject, error));
    child.once('exit', (code, signal) => finish(resolve, { code, signal }));
  });
}

function cssNumericProperty(source, selector, property) {
  const escapedSelector = escapeRegExp(selector);
  const rule = new RegExp(`${escapedSelector}\\s*\\{([^{}]*)\\}`).exec(source);
  assert.ok(rule, `missing CSS rule ${selector}`);
  const declaration = new RegExp(`${escapeRegExp(property)}\\s*:\\s*(-?\\d+)`).exec(rule[1]);
  assert.ok(declaration, `missing numeric ${property} in ${selector}`);
  return Number(declaration[1]);
}

function testResourceWiring() {
  assert.equal(packageJson.name, 'rai', `refusing unexpected project: ${packageJson.name || '(unnamed)'}`);
  assert.ok(exists(explainerPath), `${explainerPath} must exist`);
  assert.ok(exists(explainerStylesPath), `${explainerStylesPath} must exist`);
  assert.ok(explainer.length > 1000, 'selection explainer controller must not be an empty stub');
  assert.ok(explainerStyles.length > 500, 'selection explainer styles must not be an empty stub');

  assert.match(index, /<link\b[^>]*href=["'][^"']*selection-explainer\.css(?:\?[^"']*)?["'][^>]*>/i,
    'index must load the selection explainer stylesheet');
  assert.match(index, /<script\b[^>]*src=["'][^"']*selection-explainer\.js(?:\?[^"']*)?["'][^>]*><\/script>/i,
    'index must load the selection explainer controller');
  assert.match(serviceWorker, /['"]\/selection-explainer\.js(?:\?[^'"]*)?['"]/,
    'service worker must precache the selection explainer controller');
  assert.match(serviceWorker, /['"]\/selection-explainer\.css(?:\?[^'"]*)?['"]/,
    'service worker must precache the selection explainer stylesheet');

  assert.match(packageJson.scripts.check, /node --check public\/selection-explainer\.js/,
    'npm run check must syntax-check the new controller');
  assert.match(packageJson.scripts['test:formal-audit'], /test:selection-explanations/,
    'the formal gate must run the selection explanation regression');
}

function testSchemaAndAccountConfig() {
  assert.match(server, /CREATE TABLE IF NOT EXISTS selection_explanation_threads\s*\(/,
    'account history needs its own thread table');
  assert.match(server, /CREATE TABLE IF NOT EXISTS selection_explanation_cards\s*\(/,
    'account history needs its own card table');
  assert.match(server, /CREATE TABLE IF NOT EXISTS selection_explanation_requests\s*\(/,
    'point reservation and refund need an idempotency ledger');
  assert.match(server, /CREATE TABLE IF NOT EXISTS user_selection_explanation_usage\s*\(/,
    'selection explanations need a quota table separate from normal chat usage');

  assert.match(server, /selection_explanation_cards[\s\S]{0,1800}\bparent_id\b[\s\S]{0,1800}\bselected_text\b[\s\S]{0,1800}\banswer\b/,
    'cards must persist the tree edge, selected text, and answer');
  assert.match(server, /selection_explanation_cards[\s\S]{0,2400}\bstatus\b[\s\S]{0,2400}\bactual_model\b/,
    'cards must persist completion status and actual model metadata');
  const cardsDdlStart = server.indexOf('CREATE TABLE IF NOT EXISTS selection_explanation_cards');
  const cardsDdl = server.slice(cardsDdlStart, cardsDdlStart + 2400);
  assert.doesNotMatch(cardsDdl, /\b(?:context|surrounding_text|source_message|source_session|raw_html|formulas?)\b/i,
    'persistent card history must not retain surrounding chat context, source content, HTML, or formulas');
  assert.match(server, /selection_explanation_requests[\s\S]{0,2200}\bpoint_bucket\b[\s\S]{0,2200}\bstatus\b[\s\S]{0,800}['"]refunded['"]/,
    'request ledger must retain the charged bucket and refund state');

  assert.match(server, /selection_explanation_delete_mode\s+TEXT\s+DEFAULT\s+['"]promote_children['"]/,
    'safe child promotion must be the account default');
  assertContainsAll(server, ['promote_children', 'delete_subtree', 'ask_each_time'], 'delete-mode enum');

  const configRoute = routeSurface('put', '/api/user/config');
  assert.match(configRoute, /selection_explanation_delete_mode/,
    'PUT /api/user/config must persist the account delete preference');
  assert.match(configRoute, /promote_children|delete_subtree|ask_each_time/,
    'config writes must validate the delete-mode enum');
  const profileRoute = routeSurface('get', '/api/user/profile');
  assert.match(profileRoute, /selection_explanation_delete_mode/,
    'user profile reads must return the account delete preference');

  for (const table of ['selection_explanation_threads', 'selection_explanation_requests', 'user_selection_explanation_usage']) {
    const tableStart = server.indexOf(`CREATE TABLE IF NOT EXISTS ${table}`);
    assert.ok(tableStart >= 0, `missing ${table}`);
    assert.match(server.slice(tableStart, tableStart + 2400),
      /FOREIGN KEY \(user_id\) REFERENCES users\(id\) ON DELETE CASCADE/,
      `${table} must be removed with its owning account`);
  }
}

function testAuthenticatedApiAndChatIsolation() {
  const stream = routeSurface('post', '/api/selection-explanations/stream');
  const stop = routeSurface('post', '/api/selection-explanations/:requestId/stop');
  const threads = routeSurface('get', '/api/selection-explanations/threads');
  const thread = routeSurface('get', '/api/selection-explanations/threads/:threadId');
  const nodes = routeSurface('get', '/api/selection-explanations/threads/:threadId/nodes');
  const pathRoute = routeSurface('get', '/api/selection-explanations/cards/:cardId/path');
  const deleteCard = routeSurface('delete', '/api/selection-explanations/cards/:cardId');
  const deleteThread = routeSurface('delete', '/api/selection-explanations/threads/:threadId');
  const clearAll = routeSurface('delete', '/api/selection-explanations');

  for (const [name, surface] of Object.entries({ stream, stop, threads, thread, nodes, pathRoute, deleteCard, deleteThread, clearAll })) {
    assert.match(surface.slice(0, 300), /authenticateToken/, `${name} endpoint must be authenticated`);
    assert.match(surface.slice(0, 300), /apiLimiter/, `${name} endpoint must use the shared API abuse limiter`);
  }
  assert.match(stream, /parseSelectionExplanationPayload\(req\.body/);
  assert.match(server, /function parseSelectionExplanationPayload[\s\S]{0,3200}\bselectedText\b[\s\S]{0,3200}\bcontext\b[\s\S]{0,3200}\bformulas\b/,
    'the dedicated payload parser must validate selected text, ephemeral context, and exact formulas');
  assert.match(stream, /text\/event-stream|writeSSE|sendSSE/,
    'explanations must stream independently');
  assert.match(stream, /selectionExplanation|selection_explanation/i,
    'stream route must use the dedicated explanation pipeline');

  assert.doesNotMatch(stream, /checkAndDeductPoints|user_chat_usage|INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(?:sessions|messages|flows|user_memories)\b/i,
    'selection explanations must not consume or persist normal chat state');
  assert.doesNotMatch([threads, thread, nodes, pathRoute, deleteCard, deleteThread, clearAll].join('\n'),
    /\b(?:sessions|messages|flows|user_memories|user_chat_usage)\b/i,
    'history APIs must remain independent of normal chat history');
  assert.match(clearAll, /clearSelectionExplanationHistoryForUser\(req\.user\.userId\)/,
    'clear-all must use the authoritative serialized history transaction');
  assert.match(clearAll,
    /advanceSelectionExplanationHistoryGeneration\(req\.user\.userId\)[\s\S]{0,500}markHistoryCleared[\s\S]{0,300}controller\.abort\(\)[\s\S]{0,500}clearSelectionExplanationHistoryForUser/,
    'clear-all must synchronously invalidate and abort old handlers before its DB transaction');
  const authoritativeClear = sourceBetween(
    server,
    'async function clearSelectionExplanationHistoryForUser',
    'async function getSelectionExplanationRequestLifecycle',
    'authoritative selection explanation clear'
  );
  assert.match(authoritativeClear,
    /status = 'consumed'[\s\S]{0,300}error_code = 'history_cleared_inflight'[\s\S]{0,1000}DELETE FROM selection_explanation_threads/,
    'clear-all must terminally consume reservations before deleting history');
  assert.match(authoritativeClear,
    /FROM active_requests[\s\S]{0,500}session_id = 'selection_explanation'[\s\S]{0,900}UPDATE active_requests[\s\S]{0,400}SET is_cancelled = 1/,
    'clear-all must cancel every selection active row, including rows not reserved yet');
  assert.doesNotMatch(authoritativeClear,
    /UPDATE active_requests[\s\S]{0,500}id IN \([\s\S]{0,300}status = 'reserved'/,
    'active cancellation must not be limited to rows that already have a reservation');
  assert.match(stream,
    /requestHistoryGeneration\s*=\s*getSelectionExplanationHistoryGeneration[\s\S]{0,1800}req\.aborted\s*\|\|\s*res\.destroyed/,
    'the stream must synchronously capture a generation and fail closed on disconnect');
  assert.match(stream,
    /registerSelectionExplanationActiveRequest\([\s\S]{0,400}historyGeneration:\s*requestHistoryGeneration[\s\S]{0,1800}reserveSelectionExplanationPoint\([\s\S]{0,400}requestHistoryGeneration/,
    'the captured generation must guard registration and point reservation');
  const reservationSurface = sourceBetween(
    server,
    'async function reserveSelectionExplanationPoint',
    'async function consumeSelectionExplanationReservation',
    'selection explanation reservation'
  );
  assert.match(reservationSurface,
    /FROM active_requests[\s\S]{0,500}session_id = 'selection_explanation'[\s\S]{0,500}!activeRequest[\s\S]{0,300}selection_explanation_cancelled/,
    'point reservation must reject a missing or cancelled active row in the same transaction');
  assert.match(stream, /getSelectionExplanationRequestLifecycle\([\s\S]{0,500}history_cleared_inflight/,
    'the stream must recheck serialized request state before provider work');
  assert.match(stream,
    /pointReserved\s*&&\s*historyClearedByUser[\s\S]{0,1400}selection_explanation_history_cleared[\s\S]{0,500}status:\s*'discarded'/,
    'an authoritative clear must discard output without refund or a second settlement');
  const clearHistoryClient = sourceBetween(
    explainer,
    'async function clearHistory',
    'function pathFromResponse',
    'client clear history'
  );
  assert.ok(
    clearHistoryClient.indexOf('abortController?.abort()') >= 0
      && clearHistoryClient.indexOf('abortController?.abort()') < clearHistoryClient.indexOf("apiJson('/api/selection-explanations'"),
    'the browser must abort captured old streams before sending clear-all'
  );
  assert.match(deleteCard, /configuredMode[\s\S]{0,800}ask_each_time[\s\S]{0,800}choiceRequired/,
    'ask-each-time mode must defer the branch decision to the client');
  assert.ok(deleteCard.includes('outcome.choiceRequired')
      && deleteCard.includes('selection_explanation_delete_choice_required'),
  'ask-each-time mode must return an explicit client choice error');
  assert.match(deleteCard, /mode === 'promote_children'[\s\S]{0,1000}UPDATE selection_explanation_cards SET parent_id = \?/,
    'promote mode must lift direct children to the deleted card parent');
  assert.match(deleteCard, /mode === 'promote_children'[\s\S]{0,1800}WITH RECURSIVE descendants[\s\S]{0,1000}DELETE FROM selection_explanation_cards/,
    'subtree mode must recursively delete the chosen card and all descendants');
  assert.match(deleteCard, /COUNT\(\*\)[\s\S]{0,700}threadDeleted[\s\S]{0,500}DELETE FROM selection_explanation_threads/,
    'a history thread must be removed only after its final card is gone');
  assert.match(threads, /decodeSelectionExplanationCursor\(req\.query\.cursor\)/);
  assert.match(threads, /ORDER BY t\.updated_at DESC, t\.id DESC/);
  assert.match(threads, /nextCursor/,
    'thread history must use stable cursor pagination');
  assert.match(nodes, /decodeSelectionExplanationNodeCursor\(req\.query\.cursor\)/);
  assert.match(nodes, /ORDER BY c\.created_at ASC, c\.id ASC/);
  assert.match(nodes, /nextCursor/,
    'large explanation branches must remain lazily pageable with a stable order');
  assert.match(server, /SELECTION_EXPLANATION_QUOTA_PER_MINUTE|checkAndConsumeSelectionExplanationQuota/,
    'explanations need a separate per-user minute quota');
}

function testPointsNoThinkingAndFallback() {
  const stream = routeSurface('post', '/api/selection-explanations/stream');
  assert.match(server, /SELECTION_EXPLANATION_(?:POINT_)?COST\s*=\s*1\b/,
    'every fresh explanation must have a fixed one-point cost');
  assert.match(server, /\bpoints\s+INTEGER\s+NOT NULL\s+DEFAULT\s+1\s+CHECK\s*\(points\s*=\s*1\)/,
    'the idempotency ledger must reject any explanation charge other than one point');
  assert.match(server, /SELECTION_EXPLANATION_(?:MODEL|PREFERRED_MODEL)(?:_ID)?\s*=\s*['"]deepseek-flash['"]/,
    'DeepSeek Flash must be the preferred explainer model');
  assert.match(server, /(?:reserve|deduct)[A-Za-z]*SelectionExplanation[A-Za-z]*Point/i,
    'the endpoint must reserve one point before provider work');
  assert.ok(
    stream.indexOf('reserveSelectionExplanationPoint') >= 0
      && stream.indexOf('reserveSelectionExplanationPoint') < stream.indexOf('streamSelectionExplanationWithFallback'),
    'the single fixed point must be reserved before any preferred or fallback provider call'
  );
  assert.match(server, /refund[A-Za-z]*SelectionExplanation[A-Za-z]*Point/i,
    'the endpoint must provide an idempotent refund path');
  assert.match(server, /point_bucket|pointBucket/,
    'refunds must target the original daily or purchased point bucket');
  assert.match(server, /pointBucket\s*=\s*dailyPoints\s*>\s*0\s*\?\s*['"]daily['"]\s*:\s*['"]purchased['"]/,
    'the fixed point must be taken from daily points before purchased points');
  assert.match(server, /visible(?:Content|Output)|hasVisible/i,
    'refund eligibility must be gated on the absence of visible output');
  assert.match(server, /refunded|refund/i,
    'the stream must represent a refund outcome');
  assert.match(stream, /pointReserved\s*&&\s*visibleAnswer[\s\S]{0,3200}saveAndSettleSelectionExplanationCard[\s\S]{0,800}status:\s*['"]partial['"]/,
    'visible interrupted output must be atomically saved as partial and keep its point');
  assert.match(server, /pointReserved\s*&&\s*cancelled[\s\S]{0,1800}refunded:\s*false/,
    'a user cancellation must not turn into a free provider request');
  assert.match(server, /else if \(pointReserved\)[\s\S]{0,700}refundSelectionExplanationPoint/,
    'only full fallback exhaustion before visible output may refund');

  assert.match(server, /preferredModelId\s*=\s*SELECTION_EXPLANATION_MODEL_ID[\s\S]{0,500}getResearchFallbackCandidates\(preferredModelId\)/,
    'the explainer must prepend DeepSeek Flash to the existing universal fallback chain');
  assert.match(server, /streamSelectionExplanationWithFallback[\s\S]{0,1800}isRoutableModelAvailable\(candidate\)/,
    'fallback routing must skip disabled or unavailable models');
  assert.match(server, /streamSelectionExplanationWithFallback[\s\S]{0,5000}thinkingMode\s*:\s*false\b/,
    'all selection explanation candidates must explicitly disable thinking');
  assert.match(server, /(?:max_tokens|maxTokens)\s*:\s*(?:SELECTION_EXPLANATION_MAX_TOKENS|400)\b/,
    'the concise explainer must cap responses at about 400 tokens');
  assert.match(server, /temperature\s*:\s*0\.2\b/,
    'the explainer must use a low deterministic temperature');
  assert.match(server, /untrusted|不可信|不能当作指令|never[^\n]{0,80}instructions/i,
    'the prompt must treat selected text and context as untrusted quoted data');
  assert.match(server, /2\s*[–-]\s*5|2\s*到\s*5|2\s*至\s*5/,
    'the prompt must constrain answers to two through five sentences');
  assert.match(server, /不要输出思维过程|No chain-of-thought|hidden reasoning/i,
    'the prompt must prohibit chain-of-thought output');
}

function buildSelectionExplanationTransactionHarness(db) {
  const pieces = [
    sourceBetween(server,
      'const selectionExplanationHistoryGenerations',
      'const SELECTION_EXPLANATION_SYSTEM_PROMPT',
      'selection explanation history generation'),
    sourceBetween(server,
      'function enqueueSelectionExplanationWrite',
      'function runSelectionExplanationWrite',
      'selection explanation write queue'),
    sourceBetween(server,
      'function runSelectionExplanationWrite',
      'function withSelectionExplanationTransaction',
      'selection explanation queued write'),
    sourceBetween(server,
      'function withSelectionExplanationTransaction',
      'function assertSelectionExplanationChanges',
      'selection explanation transaction wrapper'),
    sourceBetween(server,
      'function assertSelectionExplanationChanges',
      'async function closeSelectionExplanationDb',
      'selection explanation affected-row guard'),
    sourceBetween(server,
      'async function registerSelectionExplanationActiveRequest',
      'async function cleanupSelectionExplanationActiveRequest',
      'selection explanation active registration'),
    sourceBetween(server,
      'async function reserveSelectionExplanationPoint',
      'async function consumeSelectionExplanationReservation',
      'selection explanation point reservation'),
    sourceBetween(server,
      'async function consumeSelectionExplanationReservation',
      'async function refundSelectionExplanationPoint',
      'selection explanation reservation settlement'),
    sourceBetween(server,
      'async function clearSelectionExplanationHistoryForUser',
      'async function getSelectionExplanationRequestLifecycle',
      'selection explanation authoritative clear history'),
    sourceBetween(server,
      'function buildSelectionExplanationTargetDeletedError',
      'async function persistSelectionExplanationDraft',
      'selection explanation deleted-target error'),
    sourceBetween(server,
      'async function saveAndSettleSelectionExplanationCardInTransaction',
      'async function saveAndSettleSelectionExplanationCard(options)',
      'selection explanation atomic card save'),
    sourceBetween(server,
      'async function saveAndSettleSelectionExplanationCard(options)',
      'async function recoverStaleSelectionExplanationReservations',
      'selection explanation card settlement wrapper'),
    sourceBetween(server,
      'async function recoverStaleSelectionExplanationReservations',
      'async function streamSelectionExplanationWithFallback',
      'selection explanation stale recovery')
  ];

  const factory = new Function(
    'selectionExplanationDbGetAsync',
    'selectionExplanationDbAllAsync',
    'selectionExplanationDbRunAsync',
    'databaseSchemaReady',
    'selectionExplanationDbReady',
    'SELECTION_EXPLANATION_POINT_COST',
    'SELECTION_EXPLANATION_STALE_MINUTES',
    'MAX_CONCURRENT_REQUESTS_PER_USER',
    'crypto',
    'normalizeSelectionExplanationLanguage',
    'mapSelectionExplanationCard',
    `'use strict';
     let selectionExplanationWriteTail = Promise.resolve();
     let selectionExplanationDbClosing = false;
     ${pieces.join('\n')}
     return {
       getSelectionExplanationHistoryGeneration,
       advanceSelectionExplanationHistoryGeneration,
       registerSelectionExplanationActiveRequest,
       reserveSelectionExplanationPoint,
       consumeSelectionExplanationReservation,
       clearSelectionExplanationHistoryForUser,
       saveAndSettleSelectionExplanationCard,
       recoverStaleSelectionExplanationReservations,
       withSelectionExplanationTransaction
     };`
  );

  return factory(
    (sql, params) => sqliteGet(db, sql, params),
    (sql, params) => sqliteAll(db, sql, params),
    (sql, params) => sqliteRun(db, sql, params),
    Promise.resolve(),
    Promise.resolve(),
    1,
    30,
    4,
    require('crypto'),
    (value) => String(value || '').startsWith('en') ? 'en' : 'zh-CN',
    (row) => row && ({
      id: row.id,
      threadId: row.thread_id,
      parentId: row.parent_id || null,
      selectedText: row.selected_text,
      answer: row.answer,
      status: row.status,
      childCount: Number(row.child_count || 0)
    })
  );
}

async function testConcurrentTransactionsAndDeleteRace() {
  assert.match(server, /selectionExplanationDb\s*=\s*new sqlite3\.Database/,
    'selection explanation writes need a dedicated SQLite connection');
  assert.match(server, /function enqueueSelectionExplanationWrite[\s\S]{0,900}selectionExplanationWriteTail/,
    'all explanation mutations must share one serialized write queue');
  const atomicSave = sourceBetween(
    server,
    'async function saveAndSettleSelectionExplanationCardInTransaction',
    'async function saveAndSettleSelectionExplanationCard(options)',
    'atomic explanation save and settlement'
  );
  assert.match(atomicSave, /INSERT INTO selection_explanation_cards[\s\S]{0,2400}UPDATE selection_explanation_requests[\s\S]{0,500}status = ['"]consumed['"]/,
    'card persistence and request-ledger settlement must occur in the same transaction');
  assert.match(atomicSave, /buildSelectionExplanationTargetDeletedError|selection_explanation_target_deleted/,
    'the atomic save must revalidate a target that may have been deleted during provider work');

  const db = new sqlite3.Database(':memory:');
  try {
    await sqliteExec(db, `
      PRAGMA foreign_keys = ON;
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        points INTEGER NOT NULL DEFAULT 0,
        purchased_points INTEGER NOT NULL DEFAULT 0,
        purchased_points_expire DATETIME
      );
      CREATE TABLE selection_explanation_threads (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE selection_explanation_cards (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        parent_id TEXT,
        selected_text TEXT NOT NULL,
        answer TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'complete' CHECK (status IN ('complete', 'partial')),
        ui_language TEXT DEFAULT 'zh-CN',
        model_id TEXT,
        actual_model TEXT,
        provider TEXT,
        usage_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (thread_id) REFERENCES selection_explanation_threads(id) ON DELETE CASCADE,
        FOREIGN KEY (parent_id) REFERENCES selection_explanation_cards(id) ON DELETE SET NULL
      );
      CREATE TABLE selection_explanation_requests (
        request_id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        point_bucket TEXT NOT NULL CHECK (point_bucket IN ('daily', 'purchased')),
        status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'consumed', 'refunded')),
        points INTEGER NOT NULL DEFAULT 1 CHECK (points = 1),
        thread_id TEXT,
        card_id TEXT,
        target_thread_id TEXT,
        parent_card_id TEXT,
        is_new_thread INTEGER NOT NULL DEFAULT 0,
        selected_text TEXT,
        answer_draft TEXT NOT NULL DEFAULT '',
        ui_language TEXT DEFAULT 'zh-CN',
        output_started INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (thread_id) REFERENCES selection_explanation_threads(id) ON DELETE SET NULL,
        FOREIGN KEY (card_id) REFERENCES selection_explanation_cards(id) ON DELETE SET NULL
      );
      CREATE TABLE active_requests (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        is_cancelled INTEGER NOT NULL DEFAULT 0
      );
    `);
    await sqliteRun(db,
      `INSERT INTO users (id, points, purchased_points) VALUES
       (1, 2, 0), (2, 1, 0), (3, 1, 0), (4, 1, 0),
       (5, 1, 0), (6, 1, 0), (7, 1, 0)`);

    const harness = buildSelectionExplanationTransactionHarness(db);
    const payload = { selectedText: '并行专业词', uiLanguage: 'zh-CN' };
    const concurrentTargets = [
      { threadId: 'parallel_thread_a', parentCardId: null, isNewThread: true },
      { threadId: 'parallel_thread_b', parentCardId: null, isNewThread: true }
    ];
    await sqliteRun(db,
      `INSERT INTO active_requests (id, user_id, session_id) VALUES
       ('parallel_request_0', 1, 'selection_explanation'),
       ('parallel_request_1', 1, 'selection_explanation')`);
    const reservations = await Promise.all(concurrentTargets.map((target, index) => (
      harness.reserveSelectionExplanationPoint(1, `parallel_request_${index}`, target, payload)
    )));
    assert.deepEqual(reservations.map((item) => item.allowed), [true, true],
      'two concurrent explanations must both reserve exactly one available point');

    await Promise.all(concurrentTargets.map((target, index) => (
      harness.saveAndSettleSelectionExplanationCard({
        userId: 1,
        requestId: `parallel_request_${index}`,
        threadId: target.threadId,
        cardId: `parallel_card_${index}`,
        parentCardId: null,
        isNewThread: true,
        selectedText: payload.selectedText,
        answer: `解释 ${index}`,
        status: 'complete',
        uiLanguage: payload.uiLanguage,
        modelResult: { modelId: 'deepseek-flash', actualModel: 'deepseek-flash', provider: 'test' }
      })
    )));

    const parallelUser = await sqliteGet(db, 'SELECT points, purchased_points FROM users WHERE id = 1');
    assert.deepEqual(parallelUser, { points: 0, purchased_points: 0 },
      'parallel reservations must deduct exactly two points without a lost update');
    const parallelLedger = await sqliteAll(db,
      `SELECT request_id, point_bucket, status, points, thread_id, card_id
       FROM selection_explanation_requests WHERE user_id = 1 ORDER BY request_id`);
    assert.equal(parallelLedger.length, 2);
    assert.ok(parallelLedger.every((row) => row.point_bucket === 'daily' && row.status === 'consumed' && row.points === 1),
      'every parallel request must have one consumed daily-point ledger row');
    assert.equal(new Set(parallelLedger.map((row) => row.card_id)).size, 2,
      'parallel settlements must retain distinct cards');
    assert.equal((await sqliteGet(db, 'SELECT COUNT(*) AS count FROM selection_explanation_threads WHERE user_id = 1')).count, 2);
    assert.equal((await sqliteGet(db,
      `SELECT COUNT(*) AS count FROM selection_explanation_cards c
       JOIN selection_explanation_threads t ON t.id = c.thread_id WHERE t.user_id = 1`)).count, 2);

    await harness.withSelectionExplanationTransaction(async (tx) => {
      await tx.run('INSERT INTO selection_explanation_threads (id, user_id) VALUES (?, ?)', ['deleted_inflight_thread', 2]);
      await tx.run(
        `INSERT INTO selection_explanation_cards
           (id, thread_id, parent_id, selected_text, answer, status, ui_language)
         VALUES (?, ?, NULL, ?, ?, 'complete', 'zh-CN')`,
        ['deleted_inflight_parent', 'deleted_inflight_thread', '原卡片', '原解释']
      );
      await tx.run(
        `INSERT INTO selection_explanation_cards
           (id, thread_id, parent_id, selected_text, answer, status, ui_language)
         VALUES (?, ?, NULL, ?, ?, 'complete', 'zh-CN')`,
        ['deleted_inflight_anchor', 'deleted_inflight_thread', '保留的同线程卡片', '用来证明线程未被删除']
      );
    });
    const inflightTarget = {
      threadId: 'deleted_inflight_thread',
      parentCardId: 'deleted_inflight_parent',
      isNewThread: false
    };
    await sqliteRun(db,
      `INSERT INTO active_requests (id, user_id, session_id)
       VALUES ('deleted_inflight_request', 2, 'selection_explanation')`);
    const inflightReservation = await harness.reserveSelectionExplanationPoint(
      2,
      'deleted_inflight_request',
      inflightTarget,
      { selectedText: '在途专业词', uiLanguage: 'zh-CN' }
    );
    assert.equal(inflightReservation.allowed, true);

    await harness.withSelectionExplanationTransaction((tx) => (
      tx.run('DELETE FROM selection_explanation_cards WHERE id = ?', ['deleted_inflight_parent'])
    ));
    await assert.rejects(
      harness.saveAndSettleSelectionExplanationCard({
        userId: 2,
        requestId: 'deleted_inflight_request',
        threadId: inflightTarget.threadId,
        cardId: 'must_not_resurrect',
        parentCardId: inflightTarget.parentCardId,
        isNewThread: false,
        selectedText: '在途专业词',
        answer: '这段输出到达时原分支已删除',
        status: 'partial',
        uiLanguage: 'zh-CN',
        modelResult: { modelId: 'deepseek-flash' }
      }),
      (error) => error?.code === 'selection_explanation_target_deleted',
      'an in-flight explanation must fail closed when its target branch was deleted'
    );
    await harness.consumeSelectionExplanationReservation(2, 'deleted_inflight_request', 'target_deleted_after_output');

    assert.equal((await sqliteGet(db,
      'SELECT COUNT(*) AS count FROM selection_explanation_threads WHERE id = ?',
      ['deleted_inflight_thread'])).count, 1,
    'the race fixture must retain its thread so the deleted-parent guard is exercised');
    assert.equal((await sqliteGet(db,
      'SELECT COUNT(*) AS count FROM selection_explanation_cards WHERE id IN (?, ?)',
      ['deleted_inflight_parent', 'must_not_resurrect'])).count, 0,
    'settlement must not recreate the deleted parent or append the in-flight card');
    assert.equal((await sqliteGet(db,
      'SELECT COUNT(*) AS count FROM selection_explanation_cards WHERE id = ?',
      ['deleted_inflight_anchor'])).count, 1,
    'discarding the stale in-flight answer must not disturb unrelated cards in the thread');
    const inflightLedger = await sqliteGet(db,
      `SELECT status, error_code, card_id FROM selection_explanation_requests
       WHERE request_id = ?`,
      ['deleted_inflight_request']);
    assert.deepEqual(inflightLedger,
      { status: 'consumed', error_code: 'target_deleted_after_output', card_id: null },
      'visible provider work discarded after deletion must stay charged and receive a terminal ledger state');
    assert.equal((await sqliteGet(db, 'SELECT points FROM users WHERE id = 2')).points, 0,
      'deleting an in-flight target must not make visible provider work free');

    const clearInflightTarget = {
      threadId: 'clear_inflight_new_thread',
      parentCardId: null,
      isNewThread: true
    };
    await sqliteRun(db,
      `INSERT INTO active_requests (id, user_id, session_id)
       VALUES ('clear_inflight_request', 3, 'selection_explanation')`);
    const clearInflightReservation = await harness.reserveSelectionExplanationPoint(
      3,
      'clear_inflight_request',
      clearInflightTarget,
      { selectedText: '清空时仍在生成的术语', uiLanguage: 'zh-CN' }
    );
    assert.equal(clearInflightReservation.allowed, true);

    harness.advanceSelectionExplanationHistoryGeneration(3);
    const clearOutcome = await harness.clearSelectionExplanationHistoryForUser(3);
    assert.equal(clearOutcome.deletedThreads, 0,
      'a reserved root explanation must not need a pre-existing thread to be cleared');
    assert.deepEqual(clearOutcome.cancelledRequestIds, ['clear_inflight_request'],
      'the clear transaction must return the exact reserved request it terminally cancelled');
    assert.equal((await sqliteGet(db,
      'SELECT is_cancelled FROM active_requests WHERE id = ?',
      ['clear_inflight_request'])).is_cancelled, 1,
    'the clear transaction must make the active request observe cancellation');

    await assert.rejects(
      harness.saveAndSettleSelectionExplanationCard({
        userId: 3,
        requestId: 'clear_inflight_request',
        threadId: clearInflightTarget.threadId,
        cardId: 'clear_inflight_must_not_resurrect',
        parentCardId: null,
        isNewThread: true,
        selectedText: '清空时仍在生成的术语',
        answer: '这段已经可见的输出也不能让历史复活',
        status: 'partial',
        uiLanguage: 'zh-CN',
        modelResult: { modelId: 'deepseek-flash' }
      }),
      (error) => error?.code === 'selection_explanation_reservation_not_reserved',
      'a settle arriving after clear-all must fail closed before inserting its new thread'
    );
    assert.equal((await sqliteGet(db,
      'SELECT COUNT(*) AS count FROM selection_explanation_threads WHERE user_id = 3')).count, 0,
    'clear-all must prevent a reserved root explanation from recreating its thread');
    assert.equal((await sqliteGet(db,
      'SELECT COUNT(*) AS count FROM selection_explanation_cards WHERE id = ?',
      ['clear_inflight_must_not_resurrect'])).count, 0,
    'clear-all must prevent late partial output from inserting a card');
    const clearedLedger = await sqliteGet(db,
      `SELECT status, error_code, target_thread_id, answer_draft
       FROM selection_explanation_requests WHERE request_id = ?`,
      ['clear_inflight_request']);
    assert.deepEqual(clearedLedger, {
      status: 'consumed',
      error_code: 'history_cleared_inflight',
      target_thread_id: null,
      answer_draft: ''
    }, 'clear-all must leave one scrubbed, terminal, non-refundable ledger record');
    assert.equal((await sqliteGet(db, 'SELECT points FROM users WHERE id = 3')).points, 0,
      'user-initiated clear-all must neither refund nor double-charge the reserved point');

    // Matrix (2): clear after the first visible delta. The draft is scrubbed and
    // a late partial settlement cannot recreate a root thread or card.
    await sqliteRun(db,
      `INSERT INTO active_requests (id, user_id, session_id)
       VALUES ('clear_after_delta_request', 4, 'selection_explanation')`);
    const deltaTarget = {
      threadId: 'clear_after_delta_thread',
      parentCardId: null,
      isNewThread: true
    };
    assert.equal((await harness.reserveSelectionExplanationPoint(
      4,
      'clear_after_delta_request',
      deltaTarget,
      { selectedText: '首个 delta 前的术语', uiLanguage: 'zh-CN' }
    )).allowed, true);
    await sqliteRun(db,
      `UPDATE selection_explanation_requests
       SET answer_draft = '已经输出的第一个片段', output_started = 1
       WHERE request_id = 'clear_after_delta_request'`);
    harness.advanceSelectionExplanationHistoryGeneration(4);
    await harness.clearSelectionExplanationHistoryForUser(4);
    await assert.rejects(
      harness.saveAndSettleSelectionExplanationCard({
        userId: 4,
        requestId: 'clear_after_delta_request',
        threadId: deltaTarget.threadId,
        cardId: 'clear_after_delta_must_not_resurrect',
        parentCardId: null,
        isNewThread: true,
        selectedText: '首个 delta 前的术语',
        answer: '已经输出的第一个片段',
        status: 'partial',
        uiLanguage: 'zh-CN',
        modelResult: { modelId: 'deepseek-flash' }
      }),
      (error) => error?.code === 'selection_explanation_reservation_not_reserved'
    );
    assert.deepEqual(await sqliteGet(db,
      `SELECT status, error_code, answer_draft, output_started
       FROM selection_explanation_requests WHERE request_id = 'clear_after_delta_request'`), {
      status: 'consumed',
      error_code: 'history_cleared_inflight',
      answer_draft: '',
      output_started: 1
    }, 'clear after a visible delta must retain one charged terminal ledger and scrub its draft');
    assert.equal((await sqliteGet(db,
      'SELECT COUNT(*) AS count FROM selection_explanation_threads WHERE user_id = 4')).count, 0);
    assert.equal((await sqliteGet(db,
      `SELECT COUNT(*) AS count FROM selection_explanation_cards
       WHERE id = 'clear_after_delta_must_not_resurrect'`)).count, 0);
    assert.equal((await sqliteGet(db, 'SELECT points FROM users WHERE id = 4')).points, 0,
      'clear after the first delta must charge exactly the one reserved point');

    // Matrix (3): clear after active registration but before point reservation.
    // No ledger or charge exists yet, and the stale generation cannot reserve.
    const registerBeforeReserveGeneration = harness.getSelectionExplanationHistoryGeneration(5);
    const registerBeforeReserve = await harness.registerSelectionExplanationActiveRequest({
      requestId: 'register_before_reserve_request',
      userId: 5,
      limit: 4,
      historyGeneration: registerBeforeReserveGeneration
    });
    assert.equal(registerBeforeReserve.allowed, true);
    harness.advanceSelectionExplanationHistoryGeneration(5);
    const registerBeforeReserveClear = await harness.clearSelectionExplanationHistoryForUser(5);
    assert.deepEqual(registerBeforeReserveClear.cancelledRequestIds, ['register_before_reserve_request']);
    const rejectedReservation = await harness.reserveSelectionExplanationPoint(
      5,
      'register_before_reserve_request',
      { threadId: 'register_before_reserve_thread', parentCardId: null, isNewThread: true },
      { selectedText: '尚未扣点', uiLanguage: 'zh-CN' },
      registerBeforeReserveGeneration
    );
    assert.equal(rejectedReservation.allowed, false);
    assert.equal(rejectedReservation.code, 'selection_explanation_history_cleared');
    assert.equal((await sqliteGet(db,
      `SELECT is_cancelled FROM active_requests
       WHERE id = 'register_before_reserve_request'`)).is_cancelled, 1);
    assert.equal((await sqliteGet(db,
      'SELECT COUNT(*) AS count FROM selection_explanation_requests WHERE user_id = 5')).count, 0,
    'a clear before reservation must not fabricate a point ledger');
    assert.equal((await sqliteGet(db, 'SELECT points FROM users WHERE id = 5')).points, 1,
      'a request cancelled before reservation must not be charged');

    // Matrix (4): stale recovery after clear must see no reserved work and must
    // never refund or recover the cleared visible draft into a new thread.
    await sqliteRun(db,
      `INSERT INTO active_requests (id, user_id, session_id)
       VALUES ('clear_before_recovery_request', 6, 'selection_explanation')`);
    const recoveryTarget = {
      threadId: 'clear_before_recovery_thread',
      parentCardId: null,
      isNewThread: true
    };
    assert.equal((await harness.reserveSelectionExplanationPoint(
      6,
      'clear_before_recovery_request',
      recoveryTarget,
      { selectedText: '恢复任务不应复活', uiLanguage: 'zh-CN' }
    )).allowed, true);
    await sqliteRun(db,
      `UPDATE selection_explanation_requests
       SET answer_draft = '可见但已清空的草稿', output_started = 1,
           updated_at = datetime('now', '-60 minutes')
       WHERE request_id = 'clear_before_recovery_request'`);
    harness.advanceSelectionExplanationHistoryGeneration(6);
    await harness.clearSelectionExplanationHistoryForUser(6);
    const recoverySummary = await harness.recoverStaleSelectionExplanationReservations();
    assert.deepEqual(recoverySummary, {
      examined: 0,
      refunded: 0,
      recoveredPartial: 0,
      discarded: 0
    }, 'stale recovery must ignore terminally cleared reservations');
    assert.deepEqual(await sqliteGet(db,
      `SELECT status, error_code, answer_draft
       FROM selection_explanation_requests WHERE request_id = 'clear_before_recovery_request'`), {
      status: 'consumed',
      error_code: 'history_cleared_inflight',
      answer_draft: ''
    });
    assert.equal((await sqliteGet(db,
      'SELECT COUNT(*) AS count FROM selection_explanation_threads WHERE user_id = 6')).count, 0);
    assert.equal((await sqliteGet(db, 'SELECT points FROM users WHERE id = 6')).points, 0,
      'stale recovery after clear must not refund the user-cancelled point');

    // Extra seam: the HTTP stream handler captured generation 0, then clear-all
    // linearized before active registration. Generation 1 rejects registration.
    const preRegisterGeneration = harness.getSelectionExplanationHistoryGeneration(7);
    harness.advanceSelectionExplanationHistoryGeneration(7);
    await harness.clearSelectionExplanationHistoryForUser(7);
    const staleRegistration = await harness.registerSelectionExplanationActiveRequest({
      requestId: 'handler_started_before_clear_request',
      userId: 7,
      limit: 4,
      historyGeneration: preRegisterGeneration
    });
    assert.equal(staleRegistration.allowed, false);
    assert.equal(staleRegistration.code, 'selection_explanation_history_cleared');
    assert.equal((await sqliteGet(db,
      'SELECT COUNT(*) AS count FROM active_requests WHERE user_id = 7')).count, 0);
    assert.equal((await sqliteGet(db, 'SELECT points FROM users WHERE id = 7')).points, 1,
      'a handler invalidated before registration must not create state or charge a point');
  } finally {
    await sqliteClose(db);
  }
}

function testSelectionScopeAndTrigger() {
  const triggerSurface = `${index}\n${app}\n${explainer}`;
  assertContainsAll(explainer, [
    '.message.user .message-text',
    '.message.assistant .message-text',
    '.chatflow-message .message-text',
    '.selection-explain-content'
  ], 'selection allowlist');
  for (const selector of ['input', 'textarea', 'select', 'button', '[contenteditable']) {
    assert.ok(explainer.includes(selector), `selection exclusions must include ${selector}`);
  }
  assert.match(explainer, /(?:anchorNode|startContainer)[\s\S]{0,800}(?:focusNode|endContainer)[\s\S]{0,800}(?:same|={2,3}|!={1,2}|contains)/i,
    'both selection endpoints must resolve to the same allowed container');
  assert.match(explainer, /DESKTOP_EXPANDED_LIMIT\s*=\s*6\b/);
  assert.match(explainer, /MOBILE_EXPANDED_LIMIT\s*=\s*3\b/);
  assert.match(explainer, /MOBILE_SELECTION_DELAY\s*=\s*220\b/);
  assert.match(explainer, /pointerdown[\s\S]{0,300}preventDefault\(\)/,
    'the pill must preserve the native selection on pointer down');
  assert.match(index, /id=["']selectionExplainPill["']/);
  assert.match(triggerSurface, /这是什么意思|What does this mean/i);
  assert.match(triggerSurface, /(?:1\s*点|1\s*point)/i,
    'the trigger should disclose the one-point cost');
  assert.match(explainer, /visualViewport/,
    'floating UI must clamp against the visual viewport');
}

function testCardsPointerKeyboardAndLimits() {
  assert.match(index, /id=["']selectionExplainCards["']/);
  assert.match(index, /id=["']selectionExplainDock["']/);
  assert.match(index, /id=["']selectionExplainDockTray["']/);
  assert.match(explainer, /selection-explain-card-header/);
  assert.match(explainer, /setPointerCapture(?:\?\.)?\(/,
    'card dragging must use pointer capture');
  assert.match(explainer, /pointermove/);
  assert.match(explainer, /pointerup|lostpointercapture/);
  assert.match(explainer, /(?:lastFocused|last_focused|focusedAt|lastInteraction|zIndex)[\s\S]{0,1200}(?:minimize|collapsed)/i,
    'over-limit cards must be minimized by recent focus order');
  assert.match(explainerStyles, /\.selection-explain-card-header[\s\S]{0,500}touch-action\s*:\s*none/,
    'only the card header should own touch dragging');
  assert.match(explainerStyles, /\.selection-explain-content[\s\S]{0,500}user-select\s*:\s*text/,
    'card answers must remain selectable for follow-up explanations');

  const cardRule = /\.selection-explain-card\s*\{([^{}]*)\}/.exec(explainerStyles);
  assert.ok(cardRule, 'missing selection explanation card CSS');
  assert.match(cardRule[1], /border\s*:\s*0\b/,
    'floating explanation cards must not use a decorative perimeter border');
  assert.match(cardRule[1], /box-shadow\s*:\s*var\(--selection-explain-card-shadow\)/,
    'floating explanation cards must use the dedicated lower-right shadow');
  const activeCardRule = /\.selection-explain-card\.is-active\s*\{([^{}]*)\}/.exec(explainerStyles);
  assert.ok(activeCardRule, 'missing active selection explanation card CSS');
  assert.doesNotMatch(activeCardRule[1], /\bborder(?:-color)?\s*:/,
    'active cards must not reintroduce the yellow perimeter stroke');
  const cardShadow = /--selection-explain-card-shadow\s*:\s*(\d+)px\s+(\d+)px/.exec(explainerStyles);
  assert.ok(cardShadow && Number(cardShadow[1]) > 0 && Number(cardShadow[2]) > 0,
    'the card shadow must visibly project toward the lower-right');
  for (const selector of ['.selection-explain-dock-button', '.selection-explain-dock-tray']) {
    const escaped = escapeRegExp(selector);
    const rule = new RegExp(`${escaped}\\s*\\{([^{}]*)\\}`).exec(explainerStyles);
    assert.ok(rule, `missing ${selector} CSS`);
    assert.match(rule[1], /border\s*:\s*0\b/, `${selector} must follow the borderless floating-surface contract`);
  }

  const dockPosition = sourceBetween(explainer, 'function updateDockPosition', 'function updateDock', 'dock positioning');
  assertContainsAll(dockPosition, [
    "composer?.querySelector('.input-wrapper, .chatflow-input-wrapper')",
    'dockAnchorRect?.left',
    'bounds.left + 10',
    'clamp(desktopLeft'
  ], 'desktop dock alignment');

  const rootZ = cssNumericProperty(explainerStyles, '.selection-explain-root', 'z-index');
  const pillZ = cssNumericProperty(explainerStyles, '.selection-explain-pill', 'z-index');
  const dockZ = cssNumericProperty(explainerStyles, '.selection-explain-dock', 'z-index');
  const historyBackdropZ = cssNumericProperty(explainerStyles, '.selection-explain-history-backdrop', 'z-index');
  const historyZ = cssNumericProperty(explainerStyles, '.selection-explain-history', 'z-index');
  const deleteZ = cssNumericProperty(explainerStyles, '.selection-explain-delete-dialog-backdrop', 'z-index');
  const initialCardZ = Number(/\bzCounter:\s*(\d+)/.exec(explainer)?.[1] || NaN);
  assert.ok(Number.isFinite(initialCardZ) && pillZ > initialCardZ && pillZ > rootZ,
    'nested selection pills must remain above reasonable dynamic card z-indices');
  assert.ok(dockZ > pillZ, 'the card dock must remain reachable above selection pills');
  assert.ok(historyBackdropZ > dockZ && historyZ > historyBackdropZ,
    'the independent history modal must remain above cards, pills, and the dock');
  assert.ok(deleteZ > historyZ, 'the destructive delete confirmation must be the top selection-explainer layer');

  assert.match(explainer, /(?:event\.)?altKey/);
  assert.match(explainer, /['"]\/['"]|Slash/,
    'Alt/Option plus slash must invoke the current valid selection');
  for (const key of ['Enter', ' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Escape']) {
    assert.ok(explainer.includes(`'${key}'`) || explainer.includes(`"${key}"`), `keyboard card control must handle ${JSON.stringify(key)}`);
  }
  assert.match(explainer, /CARD_MOVE_STEP\s*=\s*12\b/);
  assert.match(explainer, /ArrowLeft[\s\S]{0,800}CARD_MOVE_STEP|CARD_MOVE_STEP[\s\S]{0,800}ArrowLeft/,
    'keyboard movement must use a predictable step');

  const finishSurface = sourceBetween(explainer, 'function finishCard', 'function handleStreamEvent', 'finishCard');
  assert.match(finishSurface, /failed[\s\S]{0,180}error[\s\S]{0,500}setCardStatus/,
    'a refunded or failed explanation must never be relabeled as complete');
  const streamEventSurface = sourceBetween(explainer, 'function handleStreamEvent', 'async function consumeSseResponse', 'handleStreamEvent');
  assert.match(streamEventSurface, /event === ['"]done['"][\s\S]{0,800}status === ['"]failed['"][\s\S]{0,300}['"]failed['"]/,
    'the final failed SSE status must remain failed');
  const sseSurface = sourceBetween(explainer, 'async function consumeSseResponse', 'async function startExplanation', 'consumeSseResponse');
  assert.match(sseSurface, /payload\.type[\s\S]{0,300}handleStreamEvent/,
    'the client must honor the backend type field when SSE uses data-only frames');
}

function testIndependentHistoryAndDeleteModes() {
  for (const id of [
    'selectionExplainHistoryBackdrop',
    'selectionExplainHistoryDrawer',
    'selectionExplainHistoryList'
  ]) {
    assert.match(index, new RegExp(`id=["']${id}["']`), `missing independent history surface #${id}`);
  }
  assert.doesNotMatch(index, /(?:sidebar|session-list)[\s\S]{0,800}selectionExplainHistoryDrawer/,
    'explanation history must not be nested into normal conversation history');
  assert.match(explainer, /\/api\/selection-explanations\/threads/);
  assert.match(explainer, /\/api\/selection-explanations\/cards/);
  assert.match(explainer, /parent(?:Id|_id)/,
    'history must retain explanation-chain parent edges');
  const treeLoading = sourceBetween(explainer, 'async function loadTreeChildren', 'function createTreeNode', 'loadTreeChildren');
  assertContainsAll(treeLoading, ['cursor', 'nextCursor', 'selection-explain-load-more'],
    'unlimited sibling branches must remain cursor-pageable in the tree drawer');

  assertContainsAll(index + explainer, [
    'data-selection-explain-delete-mode',
    'promote_children',
    'delete_subtree',
    'ask_each_time'
  ], 'delete-mode settings');
  assert.match(app, /async function setSelectionExplanationDeleteMode[\s\S]{0,2400}\$\{API_BASE\}\/user\/config[\s\S]{0,700}method:\s*['"]PUT['"]/,
    'delete preference must sync through the account config API');
  assert.match(app, /function buildCurrentConfigPayloadForMemory[\s\S]{0,1600}selection_explanation_delete_mode/,
    'account config writes must include the selected delete mode');
  assert.match(explainer, /descendant|后代|subtree/i,
    'delete confirmation must disclose descendant scope');
  assert.match(explainer, /function showDeleteChoice[\s\S]{0,1800}preferredChoice[\s\S]{0,300}\.focus\(\)/,
    'the ask-each-time dialog must place initial focus on one of its explicit actions');
  const deleteDialogStart = index.indexOf('id="selectionExplainDeleteDialogBackdrop"');
  assert.ok(deleteDialogStart >= 0, 'missing selection explanation delete dialog');
  const deleteDialog = index.slice(deleteDialogStart, deleteDialogStart + 3000);
  assert.doesNotMatch(deleteDialog, /data-delete-choice=["']ask_each_time["']/,
    'ask-each-time must leave both destructive strategies unselected');
  assert.match(deleteDialog, /id=["']selectionExplainDeleteSetDefault["']/,
    'the confirmation must allow the one-time strategy to become the new account default');
  const requestDelete = sourceBetween(explainer, 'async function requestDeleteNode', 'async function deleteThread', 'requestDeleteNode');
  assert.match(requestDelete, /configuredMode === ['"]ask_each_time['"][\s\S]{0,500}showDeleteChoice\(descendantCount\)/,
    'ask-each-time must show the two-action dialog with the descendant count');
  assert.match(requestDelete, /choice\.setDefault[\s\S]{0,800}setSelectionExplanationDeleteMode\(choice\.mode\)/,
    'the ask-each-time dialog may promote the one-time strategy to the account default');
  assert.match(requestDelete, /deleteUrl \+= `\?mode=\$\{encodeURIComponent\(choice\.mode\)\}`/,
    'the ask-each-time strategy must reach the delete API explicitly');
  assert.match(requestDelete, /else \{[\s\S]{0,800}selection-explain-delete-fixed-(?:subtree|promote)-confirm[\s\S]{0,900}window\.confirm/,
    'fixed account modes must show a scope-specific confirmation');
  assert.match(requestDelete, /let deleteUrl = `\/api\/selection-explanations\/cards\/\$\{encodeURIComponent\(node\.id\)\}`/,
    'fixed account modes must omit a query override so the backend account setting remains authoritative');
}

function testI18nAndSafeRendering() {
  const combinedFrontEnd = [app, index, explainer].join('\n');
  assert.match(combinedFrontEnd, /selection-explain/i, 'selection explanation i18n keys must exist');
  assert.match(combinedFrontEnd, /这是什么意思/);
  assert.match(combinedFrontEnd, /這是什麼意思/);
  assert.match(combinedFrontEnd, /What does this mean/i);
  assert.match(explainer, /renderMarkdownWithMath\(/,
    'answers must reuse the sanitized Markdown and KaTeX renderer');
  assert.match(explainer, /data-rai-latex/,
    'formula selection must preserve exact LaTeX through a safe data attribute');
  assert.match(explainer, /function layoutStorageKey\(userId[\s\S]{0,300}LAYOUT_KEY_PREFIX[\s\S]{0,120}userId/,
    'device-only workspace layout must be namespaced by account');
  const persistedLayout = sourceBetween(explainer, 'function persistLayout()', 'function clearUserWorkspace', 'persistLayout');
  assert.match(persistedLayout, /localStorage\.setItem/);
  assert.doesNotMatch(persistedLayout, /\b(?:selectedText|answer|context|formulas)\b/,
    'device layout persistence must never duplicate explanation or chat text');
  assert.match(explainer, /function clearUserWorkspace[\s\S]{0,500}localStorage\.removeItem/,
    'device-only workspace state must expose logout cleanup');
  assertContainsAll(app, [
    'RAISelectionExplainer?.onUserReady',
    'RAISelectionExplainer?.clearUserWorkspace',
    'RAISelectionExplainer?.refreshLanguage'
  ], 'main-app selection explainer lifecycle hooks');
  const languageRefresh = sourceBetween(explainer, 'function refreshLanguage()', 'function reflowWorkspace', 'refreshLanguage');
  assertContainsAll(languageRefresh, ["card.status === 'partial'", "card.status === 'cancelled'", "card.status === 'failed'"],
    'language refresh must preserve complete, partial, cancelled, and failed card states');
}

function testLifecycleOwnershipAndStaleResponses() {
  assertContainsAll(explainer, [
    'lifecycleEpoch: 0',
    'requestControllers: new Set()',
    'layoutRestoreGeneration: 0',
    'controller: null',
    'generation: 0'
  ], 'cross-account request ownership state');

  const ownedRequest = sourceBetween(explainer, 'function createOwnedRequest', 'function finishOwnedRequest', 'owned request lifecycle');
  assert.match(ownedRequest, /new AbortController\(\)[\s\S]{0,500}epoch:\s*state\.lifecycleEpoch[\s\S]{0,300}userId:\s*String\(state\.userId/,
    'every history/path request must capture both an abort signal and the current account epoch');
  assert.match(ownedRequest, /requestControllers\.add\(controller\)/,
    'owned request controllers must be tracked for account teardown');
  assert.match(ownedRequest, /!owner\.controller\.signal\.aborted[\s\S]{0,300}owner\.epoch === state\.lifecycleEpoch[\s\S]{0,300}owner\.userId === String\(state\.userId/,
    'late responses must be rejected after abort, epoch change, or account change');

  const resetUser = sourceBetween(explainer, 'function resetUserState', 'function clearUserWorkspace', 'account lifecycle reset');
  assert.match(resetUser, /state\.lifecycleEpoch \+= 1[\s\S]{0,400}requestControllers\.forEach\(\(controller\) => controller\.abort\(\)\)[\s\S]{0,200}requestControllers\.clear\(\)/,
    'logout/account switch must invalidate the epoch and abort every owned request');
  assertContainsAll(resetUser, [
    'state.layoutRestoreGeneration += 1',
    'clearTimeout(state.selectionTimer)',
    'clearTimeout(state.historySearchTimer)',
    'state.selectionTimer = null',
    'state.historySearchTimer = null',
    'state.selectionSnapshot = null',
    'state.preserveSelection = false',
    "state.els.historySearch.value = ''",
    'state.history.loading = false',
    'state.history.controller = null',
    'state.history.generation += 1',
    "state.history.query = ''",
    'state.history.nodes.clear()'
  ], 'logout/account-switch transient-state cleanup');

  const historyLoading = sourceBetween(explainer, 'async function loadHistory', 'function renderHistory', 'history list loading');
  assert.match(historyLoading, /reset && state\.history\.controller[\s\S]{0,250}state\.history\.controller\.abort\(\)/,
    'a reset/search refresh must abort the previous list request instead of accepting stale results');
  assert.match(historyLoading, /const owner = createOwnedRequest\(\)[\s\S]{0,250}state\.history\.generation = generation/,
    'every list request must receive a new generation');
  assert.match(historyLoading, /apiJson\([^\n]+[\s\S]{0,180}signal:\s*owner\.controller\.signal/,
    'history list fetches must use their owned abort signal');
  assert.match(historyLoading, /if \(!isOwnedRequestCurrent\(owner\) \|\| generation !== state\.history\.generation\) return;[\s\S]{0,500}state\.history\.threads/,
    'list data must be ownership-checked immediately before it mutates history state');
  assert.match(historyLoading, /finally[\s\S]{0,300}state\.history\.controller === owner\.controller[\s\S]{0,300}isOwnedRequestCurrent\(owner\) && generation === state\.history\.generation/,
    'a stale request must not clear the active request loading state');

  const treeLoading = sourceBetween(explainer, 'async function loadTreeChildren', 'function createTreeNode', 'tree node loading');
  assert.match(treeLoading, /const owner = createOwnedRequest\(\)[\s\S]{0,1800}signal:\s*owner\.controller\.signal/,
    'lazy tree requests must participate in account-level cancellation');
  assert.match(treeLoading, /!isOwnedRequestCurrent\(owner\) \|\| !container\.isConnected/,
    'lazy tree results must validate both request ownership and their live DOM owner');

  const pathRestore = sourceBetween(explainer, 'async function restoreHistoryCard', 'async function restoreSavedWorkspace', 'history path restore');
  assert.match(pathRestore, /const owner = createOwnedRequest\(\)[\s\S]{0,500}signal:\s*owner\.controller\.signal[\s\S]{0,300}if \(!isOwnedRequestCurrent\(owner\)\) return null/,
    'path restoration must reject an old account response before creating any cards');

  const layoutRestore = sourceBetween(explainer, 'async function restoreSavedWorkspace', 'function openHistory', 'saved workspace restore');
  assertContainsAll(layoutRestore, [
    'const restoreEpoch = state.lifecycleEpoch',
    "const restoreUserId = String(state.userId || '')",
    'const restoreGeneration = state.layoutRestoreGeneration + 1',
    'state.layoutRestoreGeneration = restoreGeneration',
    'restoreEpoch !== state.lifecycleEpoch',
    "restoreUserId !== String(state.userId || '')",
    'restoreGeneration === state.layoutRestoreGeneration'
  ], 'saved-layout restoration generation guard');
  assert.match(layoutRestore, /restoreGeneration === state\.layoutRestoreGeneration[\s\S]{0,500}restoreEpoch === state\.lifecycleEpoch[\s\S]{0,300}restoreUserId === String\(state\.userId/,
    'only the current account restore generation may persist layout or update the dock');

  const userReady = sourceBetween(explainer, 'function onUserReady', 'function refreshLanguage', 'account activation');
  assert.match(userReady, /state\.userId && state\.userId !== nextUserId[\s\S]{0,180}resetUserState\(\{ removeLayout: false \}\)[\s\S]{0,300}state\.userId = nextUserId/,
    'account activation must tear down the previous owner before installing the next account id');
}

function testTeardownAndDestructiveRequestOwnership() {
  const resetUser = sourceBetween(explainer, 'function resetUserState', 'function clearUserWorkspace', 'account teardown ordering');
  const userClearIndex = resetUser.indexOf('state.userId = null');
  const cardRemovalIndex = resetUser.indexOf('removeCardFromWorkspace');
  assert.ok(userClearIndex >= 0 && cardRemovalIndex > userClearIndex,
    'teardown must detach the old account id before stopping in-flight cards can trigger any layout side effect');
  assert.match(resetUser, /removeCardFromWorkspace\(workspaceId, \{ stop: true, persist: false \}\)/,
    'teardown must remove every card without persisting an intermediate layout');
  assert.match(resetUser, /removeCardFromWorkspace[\s\S]{0,400}if \(removeLayout\)[\s\S]{0,180}localStorage\.removeItem\(key\)/,
    'layout-removing teardown must delete the old account key again after all in-flight cards are stopped');

  const stopCard = sourceBetween(explainer, 'async function stopCardGeneration', 'function removeCardFromWorkspace', 'card stop behavior');
  assert.match(stopCard, /\{ persist = true, refreshHistory = true \}/,
    'card stop side effects must be independently suppressible during teardown');
  assert.match(stopCard, /if \(persist\) persistLayout\(\)/,
    'teardown must be able to suppress stop-time layout persistence');
  assert.match(stopCard, /finally\(\(\) => \{[\s\S]{0,180}if \(refreshHistory\) setTimeout\(\(\) => loadHistory\(\{ reset: true \}\)/,
    'teardown must be able to suppress the delayed stop-time history refresh');
  const removeCard = sourceBetween(explainer, 'function removeCardFromWorkspace', 'function bindCardDrag', 'card removal behavior');
  assert.match(removeCard, /stopCardGeneration\(card, \{ persist, refreshHistory: persist \}\)/,
    'non-persisting card removal must also disable the asynchronous history refresh');

  const clearWorkspace = sourceBetween(explainer, 'function clearUserWorkspace', 'function renderMarkdown', 'logout workspace cleanup');
  assert.match(clearWorkspace, /layoutStorageKey\(userId \|\| state\.userId\)[\s\S]{0,160}localStorage\.removeItem\(key\)[\s\S]{0,160}resetUserState\(\{ removeLayout: false \}\)/,
    'logout must remove the captured old-account layout key before clearing the active owner');

  const deleteNode = sourceBetween(explainer, 'async function requestDeleteNode', 'async function deleteThread', 'owned node deletion');
  assert.match(deleteNode, /const owner = createOwnedRequest\(\)/,
    'node deletion must capture the initiating account owner');
  assert.match(deleteNode, /const result = await apiJson\(deleteUrl, \{ method: ['"]DELETE['"], signal: owner\.controller\.signal \}\)[\s\S]{0,120}if \(!isOwnedRequestCurrent\(owner\)\) return/,
    'node deletion must use an abort signal and reject a response from an old account before local mutation');
  assert.match(deleteNode, /catch \(error\)[\s\S]{0,180}error\?\.name !== ['"]AbortError['"] && isOwnedRequestCurrent\(owner\)[\s\S]{0,240}finally[\s\S]{0,120}finishOwnedRequest\(owner\)/,
    'stale node-deletion failures must not notify the next account and controllers must be released');

  const deleteThread = sourceBetween(explainer, 'async function deleteThread', 'async function clearHistory', 'owned thread deletion');
  assert.match(deleteThread, /const owner = createOwnedRequest\(\)[\s\S]{0,500}apiJson\([^\n]+\{ method: ['"]DELETE['"], signal: owner\.controller\.signal \}\)[\s\S]{0,120}if \(!isOwnedRequestCurrent\(owner\)\) return/,
    'thread deletion must reject an old-account response before removing cards or persisting layout');
  assert.match(deleteThread, /catch \(error\)[\s\S]{0,180}isOwnedRequestCurrent\(owner\)[\s\S]{0,240}finally[\s\S]{0,120}finishOwnedRequest\(owner\)/,
    'stale thread-deletion failures must not notify the next account');

  const clearHistory = sourceBetween(explainer, 'async function clearHistory', 'function pathFromResponse', 'owned clear-all deletion');
  assert.match(clearHistory, /const owner = createOwnedRequest\(\)[\s\S]{0,500}apiJson\(\s*['"]\/api\/selection-explanations['"], \{ method: ['"]DELETE['"], signal: owner\.controller\.signal \}\)[\s\S]{0,120}if \(!isOwnedRequestCurrent\(owner\)\) return/,
    'clear-all must reject an old-account response before clearing cards, layout, or history state');
  assert.match(clearHistory, /if \(!isOwnedRequestCurrent\(owner\)\) return;[\s\S]{0,300}workspaceIdsToClear\.forEach[\s\S]{0,300}removeCardFromWorkspace[\s\S]{0,300}persistLayout\(\)/,
    'clear-all card removal must remain behind the response ownership check');
  assert.match(clearHistory, /await loadHistory\(\{ reset: true \}\)[\s\S]{0,160}if \(!isOwnedRequestCurrent\(owner\)\) return;[\s\S]{0,160}notify\(/,
    'an account switch during clear-all history refresh must suppress the old-account success toast');
  assert.match(clearHistory, /catch \(error\)[\s\S]{0,180}error\?\.name !== ['"]AbortError['"] && isOwnedRequestCurrent\(owner\)[\s\S]{0,240}finally[\s\S]{0,120}finishOwnedRequest\(owner\)/,
    'stale clear-all failures must not notify the next account and controllers must be released');
}

function testRefundAndAccessibilityContracts() {
  const streamEvents = sourceBetween(explainer, 'function handleStreamEvent', 'async function consumeSseResponse', 'selection SSE event handling');
  const refundedEvent = sourceBetween(streamEvents, "if (event === 'refunded')", "if (event === 'error')", 'refunded SSE event');
  assert.match(refundedEvent, /if \(!card\.refundNotified\)[\s\S]{0,160}card\.refundNotified = true[\s\S]{0,160}notify\(tr\(['"]selection-explain-refunded['"]/,
    'the refunded event must mark its toast as delivered before notifying');
  assert.equal((refundedEvent.match(/notify\(tr\(['"]selection-explain-refunded['"]/g) || []).length, 1,
    'the refunded event must contain only one refund notification path');
  const errorEvent = sourceBetween(streamEvents, "if (event === 'error')", "if (event === 'done')", 'error SSE event');
  assert.match(errorEvent, /payload\?\.refunded && !card\.refundNotified[\s\S]{0,160}card\.refundNotified = true[\s\S]{0,160}notify\(tr\(['"]selection-explain-refunded['"]/,
    'a refunded error event must reuse the same per-card toast guard');
  assert.equal((errorEvent.match(/notify\(tr\(['"]selection-explain-refunded['"]/g) || []).length, 1,
    'the error event must not add an unguarded second refund toast');
  assert.equal((streamEvents.match(/notify\(tr\(['"]selection-explain-refunded['"]/g) || []).length, 2,
    'refund notifications may exist only in the guarded refunded and refunded-error branches');

  assert.match(index,
    /id=["']selectionExplainHistoryDrawer["'][^>]*role=["']dialog["'][^>]*aria-modal=["']true["'][^>]*aria-labelledby=["']selectionExplainHistoryTitle["'][^>]*aria-hidden=["']true["']/,
    'the closed history drawer must expose dialog semantics without entering the accessibility tree');
  const openHistory = sourceBetween(explainer, 'function openHistory', 'function closeHistory', 'history drawer open');
  assert.match(openHistory, /historyDrawer\.inert = false[\s\S]{0,240}aria-hidden['"], ['"]false/,
    'opening history must remove inert before exposing the drawer');
  const closeHistory = sourceBetween(explainer, 'function closeHistory', 'function onUserReady', 'history drawer close');
  assert.match(closeHistory, /aria-hidden['"], ['"]true[\s\S]{0,180}historyDrawer\.inert = true/,
    'closing history must make the hidden drawer inert');
  const initSurface = sourceBetween(explainer, 'function init()', 'window.RAISelectionExplainer', 'selection explainer initialization');
  assert.match(initSurface, /state\.els\.historyDrawer\.inert = true/,
    'the initially hidden history drawer must be inert before interaction');

  assert.match(index,
    /id=["']selectionExplainDeleteDialog["'][^>]*role=["']alertdialog["'][^>]*aria-modal=["']true["'][^>]*aria-labelledby=["']selectionExplainDeleteDialogTitle["'][^>]*aria-describedby=["']selectionExplainDeleteDialogMessage["']/,
    'the destructive branch dialog must be an alert dialog tied to its title and consequence description');
  assert.match(index, /<p\s+id=["']selectionExplainDeleteDialogMessage["'][^>]*><\/p>/,
    'the alert dialog described-by target must exist as a dedicated message element');

  assert.ok(cssNumericProperty(explainerStyles, '.selection-explain-tree-row', 'min-height') >= 40,
    'tree rows must provide at least a 40px interaction lane');
  assert.ok(cssNumericProperty(explainerStyles, '.selection-explain-tree-open', 'min-height') >= 40,
    'the main tree-node action must provide at least a 40px touch target');
  const mobileStyles = sourceBetween(explainerStyles, '@media (max-width: 768px)', '@media (max-width: 420px)', 'mobile selection explainer styles');
  assert.match(mobileStyles, /\.selection-explain-tree-delete[\s\S]{0,180}\{[\s\S]{0,120}width:\s*40px;[\s\S]{0,120}height:\s*40px;/,
    'mobile tree delete controls must expand to a 40 by 40 pixel touch target');
}

async function testStartupReadinessAndInvalidSchema() {
  assert.match(server, /const databaseInitializationSettled = new Promise\([\s\S]{0,300}resolveDatabaseInitializationSettled[\s\S]{0,200}rejectDatabaseInitializationSettled/,
    'selection startup needs an explicit barrier for all queued main-database initialization work');
  assert.match(server, /databaseSchemaReady[\s\S]{0,180}\.then\(\(\) => dbGetAsync\(['"]SELECT 1 AS initialization_barrier['"]\)\)[\s\S]{0,180}resolveDatabaseInitializationSettled\(true\)/,
    'the initialization-settled barrier must enqueue a read after all serialized schema migrations');

  const selectionConnectionInit = sourceBetween(
    server,
    'databaseInitializationSettled.then(() => {',
    'let selectionExplanationWriteTail',
    'selection database connection initialization'
  );
  const closingGuardIndex = selectionConnectionInit.indexOf('if (selectionExplanationDbClosing)');
  const connectionOpenIndex = selectionConnectionInit.indexOf('selectionExplanationDb = new sqlite3.Database');
  assert.ok(closingGuardIndex >= 0 && connectionOpenIndex > closingGuardIndex,
    'shutdown must be able to reject selection connection creation before the connection is opened');
  assert.match(selectionConnectionInit, /rejectSelectionExplanationDbReady\(error\)[\s\S]{0,80}return/,
    'a connection blocked by shutdown must terminally reject selection readiness');

  const schemaVerification = sourceBetween(
    server,
    'async function verifySelectionExplanationSchema',
    'const selectionExplanationStartupReady',
    'selection schema verification'
  );
  assertContainsAll(schemaVerification, [
    'selection_explanation_threads',
    'selection_explanation_cards',
    'selection_explanation_requests',
    'user_selection_explanation_usage',
    'user_configs',
    'target_thread_id',
    'parent_card_id',
    'answer_draft',
    'output_started',
    'selection_explanation_delete_mode'
  ], 'required selection schema columns');
  assert.match(schemaVerification, /PRAGMA table_info\(\$\{tableName\}\)[\s\S]{0,400}missingColumns[\s\S]{0,400}selection_explanation_schema_invalid/,
    'startup must reject any required selection table column that remains missing after migrations');

  const selectionStartup = sourceBetween(
    server,
    'const selectionExplanationStartupReady',
    'selectionExplanationStartupReady.catch',
    'selection startup readiness'
  );
  assert.match(selectionStartup, /Promise\.all\(\[[\s\S]{0,160}databaseInitializationSettled[\s\S]{0,120}selectionExplanationDbReady[\s\S]{0,160}\]\)/,
    'selection readiness must wait for both settled migrations and the dedicated connection');
  assert.ok(selectionStartup.indexOf('await verifySelectionExplanationSchema()') >= 0
      && selectionStartup.indexOf('await verifySelectionExplanationSchema()')
        < selectionStartup.indexOf('await recoverStaleSelectionExplanationReservations()'),
  'schema validation must finish before stale reservations or the recovery timer can run');

  const httpStartup = sourceBetween(server, 'async function startHttpServer', '// 优雅退出', 'HTTP startup readiness');
  assert.ok(httpStartup.indexOf('await selectionExplanationStartupReady') >= 0
      && httpStartup.indexOf('await selectionExplanationStartupReady') < httpStartup.indexOf('app.listen('),
  'HTTP must not begin listening until selection schema verification and recovery are ready');
  assert.match(httpStartup, /await selectionExplanationStartupReady[\s\S]{0,160}if \(gracefulShutdownStarted\) return null[\s\S]{0,300}app\.listen\(/,
    'shutdown requested during initialization must prevent a late HTTP listener');

  const selectionClose = sourceBetween(
    server,
    'async function closeSelectionExplanationDb',
    'function passkeyDbGetAsync',
    'selection database shutdown'
  );
  assert.match(selectionClose, /selectionExplanationDbClosing = true[\s\S]{0,180}selectionExplanationWriteTail[\s\S]{0,240}if \(!selectionExplanationDb\)[\s\S]{0,160}selectionExplanationDbReady\.catch/,
    'selection shutdown must close the write gate, drain writes, and wait for an in-progress connection initialization');
  const gracefulShutdown = sourceBetween(server, 'async function gracefulShutdown', "process.on('SIGTERM'", 'graceful shutdown readiness');
  assert.match(gracefulShutdown, /await databaseInitializationSettled\.catch\(\(\) => undefined\)[\s\S]{0,160}await closeSelectionExplanationDb\(\)/,
    'shutdown must wait for queued main schema initialization before closing shared database handles');
  assert.match(server, /startHttpServer\(\)\.catch\([\s\S]{0,300}gracefulShutdown\(['"]STARTUP_FAILURE['"], 1\)/,
    'startup readiness failure must clean up resources and exit unsuccessfully');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rai-selection-schema-regression-'));
  const invalidDbPath = path.join(tempDir, 'missing-selection-columns.sqlite');
  const invalidDb = new sqlite3.Database(invalidDbPath);
  let child = null;
  let probeTimer = null;
  let listened = false;
  let childOutput = '';
  try {
    await sqliteExec(invalidDb, `
      CREATE TABLE user_selection_explanation_usage (
        user_id INTEGER NOT NULL,
        window_start INTEGER NOT NULL,
        PRIMARY KEY (user_id, window_start)
      );
    `);
    await sqliteClose(invalidDb);

    const port = await reserveLoopbackPort();
    child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        HOST: '127.0.0.1',
        PORT: String(port),
        RAI_DB_PATH: invalidDbPath,
        PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
        CORS_ORIGINS: `http://127.0.0.1:${port}`,
        JWT_SECRET: 'selection-schema-regression-jwt-secret-0000000000000000',
        ADMIN_JWT_SECRET: 'selection-schema-regression-admin-secret-000000000000',
        ADMIN_PASSWORD_HASH: '$2b$10$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        ZTX6D_FORCE_DISABLED: 'true',
        RAI_DEFAULT_DOMAIN_NOTICE_ENABLED: 'false'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const appendOutput = (chunk) => {
      childOutput = `${childOutput}${String(chunk || '')}`.slice(-100000);
    };
    child.stdout.on('data', appendOutput);
    child.stderr.on('data', appendOutput);
    probeTimer = setInterval(() => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      socket.unref();
      socket.setTimeout(100);
      socket.once('connect', () => {
        listened = true;
        socket.destroy();
      });
      socket.once('timeout', () => socket.destroy());
      socket.once('error', () => socket.destroy());
    }, 25);

    const outcome = await waitForChildExit(child);
    clearInterval(probeTimer);
    probeTimer = null;
    assert.equal(outcome.code, 1,
      `invalid selection schema must exit with code 1; output:\n${childOutput.slice(-5000)}`);
    assert.equal(listened, false,
      `invalid selection schema must never accept an HTTP connection; output:\n${childOutput.slice(-5000)}`);
    assert.match(childOutput, /selection_explanation_schema_missing:user_selection_explanation_usage\.usage_count/,
      'invalid-schema startup must report the exact missing selection table columns');
    assert.match(childOutput, /RAI 启动失败/,
      'invalid selection schema must reject the top-level startup promise');
    assert.doesNotMatch(childOutput, /RAI v\d[^\n]*已启动/,
      'invalid selection schema must never print the HTTP-ready banner');
  } finally {
    if (probeTimer) clearInterval(probeTimer);
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (invalidDb.open) await sqliteClose(invalidDb).catch(() => undefined);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  const tests = [
    testResourceWiring,
    testSchemaAndAccountConfig,
    testAuthenticatedApiAndChatIsolation,
    testPointsNoThinkingAndFallback,
    testSelectionScopeAndTrigger,
    testCardsPointerKeyboardAndLimits,
    testIndependentHistoryAndDeleteModes,
    testI18nAndSafeRendering,
    testLifecycleOwnershipAndStaleResponses,
    testTeardownAndDestructiveRequestOwnership,
    testRefundAndAccessibilityContracts
  ];
  for (const test of tests) test();
  await testConcurrentTransactionsAndDeleteRace();
  await testStartupReadinessAndInvalidSchema();
  console.log(`selection-explanation-regression ok (${tests.length + 2}/${tests.length + 2})`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`selection-explanation-regression failed: ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  routeSurface,
  sourceBetween,
  cssNumericProperty,
  testResourceWiring,
  testSchemaAndAccountConfig,
  testAuthenticatedApiAndChatIsolation,
  testPointsNoThinkingAndFallback,
  testSelectionScopeAndTrigger,
  testCardsPointerKeyboardAndLimits,
  testIndependentHistoryAndDeleteModes,
  testI18nAndSafeRendering,
  testLifecycleOwnershipAndStaleResponses,
  testTeardownAndDestructiveRequestOwnership,
  testRefundAndAccessibilityContracts,
  testConcurrentTransactionsAndDeleteRace,
  testStartupReadinessAndInvalidSchema
};
