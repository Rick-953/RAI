#!/usr/bin/env node

'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const app = read('public/app.js');
const selection = read('public/selection-explainer.js');
const index = read('public/index.html');
const brand = read('public/runtime-brand.js');
const sw = read('public/sw.js');
const server = read('server.js');

assert.match(index, /<script src="runtime-config\.js"><\/script>/);
assert.doesNotMatch(index, /<script src="\/runtime-config\.js">/);
assert.match(app, /const RAI_WEB_BASE_PATH = getRaiWebBasePath\(\)/);
assert.match(app, /: `\$\{RAI_WEB_BASE_PATH\}\/api`/);
assert.match(app, /globalThis\.RAI_API_BASE = API_BASE/);
assert.doesNotMatch(app, /fetch\(\s*(?:['"]|`)\/api/);
assert.match(selection, /function apiPath\(url\)/);
assert.match(selection, /fetch\(apiPath\('\/api\/selection-explanations\/stream'\)/);
assert.doesNotMatch(selection, /fetch\(\s*(?:['"]|`)\/api/);
assert.match(brand, /navigator\.serviceWorker\.register\(`\$\{scope\}sw\.js`, \{ scope, updateViaCache: 'none' \}\)/);
assert.doesNotMatch(brand, /register\('\/sw\.js'/);
assert.match(sw, /const RAI_SCOPE_PATH = new URL\(self\.registration\.scope\)\.pathname/);
assert.match(sw, /const RAI_NAVIGATION_FALLBACK = appPath\('index\.html'\)/);
assert.match(sw, /\]\.map\(appPath\)/);
assert.match(sw, /url\.pathname\.startsWith\(appPath\('api\/'\)\)/);
assert.match(sw, /url\.pathname === appPath\('runtime-config\.js'\)/);
assert.match(server, /app\.get\(\['\/', '\/index\.html'\],[\s\S]{0,300}Cache-Control', 'no-store/);
console.log('beta base-path regression passed');
