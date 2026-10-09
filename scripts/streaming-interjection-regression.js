'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

assert.match(app, /function appendVisibleInterjection\(interjection\)/);
assert.match(app, /appendVisibleInterjection\(interjection\);/);
assert.match(app, /parsed\.type === 'user_interjection'/);
assert.match(app, /await submitStreamingInterjection\(messageText\);/);
assert.doesNotMatch(app, /if \(messageText && currentAttachments\.length === 0\)/);
assert.match(server, /for \(const interjection of collectRequestInterjections\(requestId\)\)/);
assert.match(server, /type: 'user_interjection'/);

assert.match(server, /INSERT INTO messages \(session_id, role, content, created_at\)/);
console.log('streaming-interjection-regression ok interjection persist');