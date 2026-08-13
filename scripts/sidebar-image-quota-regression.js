#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const explainer = fs.readFileSync(path.join(root, 'public/selection-explainer.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'public/styles.css'), 'utf8');

const checks = [
  ['idempotent organization migration', /CREATE TABLE IF NOT EXISTS conversation_folders[\s\S]*?conversation_folder_sessions[\s\S]*?session_pins/],
  ['folder ownership checks', /SELECT id FROM conversation_folders WHERE id = \? AND user_id = \?[\s\S]*?SELECT id FROM sessions WHERE user_id = \?/],
  ['pin order complete-set transaction', /app\.put\('\/api\/sessions\/pins\/order'[\s\S]*?sessionIds\.length !== expected\.size[\s\S]*?UPDATE session_pins SET position/],
  ['paged sessions exclude pins and message bodies', /NOT EXISTS \(SELECT 1 FROM session_pins[\s\S]{0,500}ORDER BY s\.updated_at DESC/],
  ['conversation explanation ownership and filtering', /session_not_owned[\s\S]*?t\.session_id = \?/],
  ['Image 2 Shanghai quota transaction', /async function reserveImage2Quota[\s\S]{0,2500}withMainDbTransaction/],
  ['Image 2 release on failed delivery', /settleImage2QuotaReservation\(requestId, false\)/],
  ['title-only date-group sidebar', /function getSessionDateGroup[\s\S]*?function createSessionElement[\s\S]*?session-menu-btn/],
  ['session refresh assigns the full pinned collection', /async function loadSessions[\s\S]{0,7000}appState\.pinnedSessions = Array\.isArray\(data\.pinned\)/],
  ['pinned changes participate in sidebar refresh signatures', /function getSessionListRenderSignature[\s\S]{0,1800}pinned:/],
  ['ordinary session groups exclude pinned ids from cached manifests', /function renderSessions[\s\S]{0,1800}const pinnedIds = new Set\(pinned\.map[\s\S]{0,500}!pinnedIds\.has[\s\S]{0,900}\[\.\.\.ordinarySessions\]\.sort/],
  ['pinned-only sidebars do not show the empty state', /function renderSessions[\s\S]{0,2400}ordinarySessions\.length === 0 && pinned\.length === 0/],
  ['folder naming uses an in-app card and persists expansion', /function showConversationFolderNameCard[\s\S]{0,4000}rai\.sidebar\.folder\.\$\{folder\.id\}\.open/],
  ['folder duplicate errors explain the conflicting name', /保存失败：已经有名为“\$\{name\}”的文件夹/],
  ['empty folder manager offers folder creation', /还没有文件夹[\s\S]{0,800}data-action="create"/],
  ['folder membership uses exact single-session reads and writes', /\/sessions\/\$\{encodeURIComponent\(session\.id\)\}\/conversation-folders[\s\S]{0,2600}method: check\.checked \? 'PUT' : 'DELETE'/],
  ['folder membership mutation is idempotent and scoped', /app\.route\('\/api\/conversation-folders\/:folderId\/sessions\/:sessionId'\)[\s\S]{0,3500}INSERT OR IGNORE[\s\S]{0,3500}DELETE FROM conversation_folder_sessions/],
  ['conversation menu button toggles its active menu', /existing\.dataset\.triggerSessionMenu === trigger\.dataset\.sessionMenuId[\s\S]{0,1400}setAttribute\('aria-expanded', 'true'\)/],
  ['pinned touch reorder requires a long press', /setTimeout\(\(\) =>[\s\S]{0,800}touch-dragging[\s\S]{0,1800}elementFromPoint/]
];

for (const [label, pattern] of checks) assert.match(server + '\n' + app, pattern, label);
assert.match(index, /conversationFoldersSection[\s\S]*?pinnedSessionsSection[\s\S]*?sessionsContainer/, 'sidebar must expose folders, pins, then ordinary sessions');
assert.match(explainer, /sessionId: getAppState\(\)\?\.currentSession\?\.id[\s\S]*?params\.set\('sessionId'/,
  'new explanations and history filtering must carry the current session id');
assert.match(styles, /\.session-item \{[\s\S]{0,160}display: flex;[\s\S]{0,80}align-items: center;/,
  'conversation rows must keep title, time, and menu on one compact line');
console.log(`sidebar-image-quota-regression ok (${checks.length + 3}/${checks.length + 3})`);
