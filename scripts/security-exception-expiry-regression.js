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
  documentedIds.push(id);
}

const workflowIgnore = workflow.match(/^\s*ignore:\s*([^\n]+)$/m)?.[1] || '';
const workflowIds = workflowIgnore.split(',').map((value) => value.trim()).filter(Boolean);
assert.deepStrictEqual([...new Set(workflowIds)].sort(), [...new Set(documentedIds)].sort(), 'RustSec workflow ignores must exactly mirror expiring OSV exceptions');

console.log(`security-exception-expiry-regression ok (exceptions=${documentedIds.length})`);
