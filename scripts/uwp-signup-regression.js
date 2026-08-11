'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const html = read('public/uwp-signup.html');
const css = read('public/uwp-signup.css');
const client = read('public/uwp-signup.js');
const server = read('server.js');
const packageJson = JSON.parse(read('package.json'));

assert.match(packageJson.version, /^\d+\.\d+\.\d+$/, 'package version must remain valid semver');
assert.match(html, /^<!DOCTYPE html>/i);
assert.match(html, /http-equiv="X-UA-Compatible" content="IE=edge"/i);
assert.match(html, /lang="zh-CN"/);
assert.match(html, /href="\/uwp-signup\.css\?v=20260801-uwp-signup-v01174"/);
assert.match(html, /src="\/uwp-signup\.js\?v=20260801-uwp-signup-v01174"/);
assert.doesNotMatch(html, /<script\b(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i);
assert.doesNotMatch(html, /\son[a-z]+\s*=/i);

for (const id of [
  'registrationForm', 'email', 'username', 'password', 'passwordConfirm',
  'verificationForm', 'verificationCode', 'resendButton', 'completionView'
]) {
  assert.match(html, new RegExp(`id="${id}"`), `missing UWP signup control: ${id}`);
}

assert.match(html, /感谢您的注册，您现在可以返回UWP登录页登录了/);
assert.doesNotMatch(html, /Passkey|通行密钥|找回密码|忘记密码/);
assert.doesNotMatch(client, /\/api\/auth\/login/);
assert.match(css, /#0078d7/);
assert.match(css, /font-family:\s*"Segoe UI"/);
assert.match(css, /@media\s+\(-ms-high-contrast:\s*active\)/);
assert.doesNotMatch(css, /border-radius|box-shadow|text-shadow|animation|transition|transform|linear-gradient|radial-gradient|var\s*\(|display:\s*grid/i);

assert.match(client, /new XMLHttpRequest\(\)/);
assert.match(client, /postJson\('\/api\/auth\/register'/);
assert.match(client, /postJson\('\/api\/auth\/register\/verify'/);
assert.match(client, /postJson\('\/api\/auth\/register\/resend'/);
assert.equal((client.match(/registrationOnly:\s*true/g) || []).length, 3);
assert.match(client, /password\.length < 8 \|\| password\.length > 128/);
assert.match(client, /\/\^\\d\{6\}\$\/\.test\(code\)/);
assert.doesNotMatch(client, /\b(?:let|const|class|async|await|fetch|Promise)\b|=>|`|\?\.|\?\?|\.finally\s*\(|\b(?:localStorage|sessionStorage)\b|document\.cookie/);

assert.match(server, /app\.get\(\['\/UWP-SignUP', '\/UWP-SignUP\/'\]/);
assert.match(server, /sendFile\(path\.join\(__dirname, 'public', 'uwp-signup\.html'\)\)/);
assert.match(server, /issueSession = true/);
assert.match(server, /const EMAIL_CODE_TTL_MS = 5 \* 60 \* 1000/);
assert.match(server, /const EMAIL_CODE_LENGTH = 6/);
assert.match(server, /crypto\.randomInt\(0, 1000000\)[\s\S]{0,80}padStart\(EMAIL_CODE_LENGTH, '0'\)/);
assert.match(server, /return \/\^\\d\{6\}\$\/\.test\(normalized\)/);
assert.match(server, /if \(!issueSession\)[\s\S]{0,420}registrationOnly: true/);
assert.equal((server.match(/issueSession: req\.body\?\.registrationOnly !== true/g) || []).length, 3);
assert.ok(
  server.indexOf('if (!issueSession)') < server.indexOf('buildAuthenticatedUserPayload(updatedUser'),
  'registration-only completion must return before creating a Web session'
);

console.log('UWP signup regression ok (IE10/EdgeHTML static contract, two-step registration, session-free completion)');
