'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const osvConfig = fs.readFileSync(path.join(root, 'src-tauri', 'osv-scanner.toml'), 'utf8');
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'security.yml'), 'utf8');
const today = new Date();
today.setUTCHours(0, 0, 0, 0);

const blocks = osvConfig.split(/\[\[IgnoredVulns\]\]/).slice(1);
assert.ok(blocks.length > 0, 'expected documented RustSec exceptions');

const documentedIds = [];
for (const block of blocks) {
  const id = block.match(/^\s*id\s*=\s*"([^"]+)"/m)?.[1];
  const expiryText = block.match(/^\s*ignoreUntil\s*=\s*(\d{4}-\d{2}-\d{2})/m)?.[1];
  const reason = block.match(/^\s*reason\s*=\s*"([^"]+)"/m)?.[1];
  assert.ok(id && expiryText && reason, 'each ignored advisory needs id, ignoreUntil, and reason');
  const expiry = new Date(`${expiryText}T00:00:00.000Z`);
  assert.ok(Number.isFinite(expiry.getTime()), `invalid expiry for ${id}`);
  assert.ok(expiry >= today, `${id} exception expired on ${expiryText}`);
  const daysRemaining = Math.ceil((expiry - today) / 86400000);
  assert.ok(daysRemaining <= 120, `${id} exception is too long-lived (${daysRemaining} days)`);
  if (id.startsWith('RUSTSEC-')) documentedIds.push(id);
  else assert.equal(id, 'GHSA-qwgh-2vcv-g2f7', 'unexpected advisory scope exception');
}

// This decision is valid only for the exact older separate-cursor implementation.
for (const directory of ['src-tauri', 'rai-agent']) {
  const lock = fs.readFileSync(path.join(root, directory, 'Cargo.lock'), 'utf8');
  const record = lock.split('[[package]]').find(block => /^\s*name = "block-buffer"$/m.test(block));
  assert.ok(record, `${directory}: block-buffer record missing`);
  assert.match(record, /^version = "0\.10\.4"$/m, 'changed block-buffer version needs a new scope review');
  assert.match(record, /^checksum = "3078c7629b62d3f0439517fa394996acacc5cbc91c5a20d8c658e77abd503a71"$/m,
    'changed block-buffer source needs a new scope review');
  const config = fs.readFileSync(path.join(root, directory, 'osv-scanner.toml'), 'utf8');
  const decision = config.split('[[IgnoredVulns]]').find(block => /id = "GHSA-qwgh-2vcv-g2f7"/.test(block));
  assert.ok(decision && /ignoreUntil = 2026-11-11/.test(decision) && /separate pos u8 field/.test(decision),
    'advisory scope exception must be documented, narrow and expiring');
  assert.ok(today <= new Date('2026-11-11T00:00:00Z'), 'block-buffer version-scope review expired');
}

const workflowIgnore = workflow.match(/^\s*ignore:\s*([^\n]+)$/m)?.[1] || '';
const workflowIds = workflowIgnore.split(',').map((value) => value.trim()).filter(Boolean);
assert.deepStrictEqual([...new Set(workflowIds)].sort(), [...new Set(documentedIds)].sort(), 'RustSec workflow ignores must exactly mirror expiring OSV exceptions');

console.log(`security-exception-expiry-regression ok (exceptions=${documentedIds.length})`);
