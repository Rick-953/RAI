'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const publicRoot = path.join(root, 'public');
const manifest = JSON.parse(fs.readFileSync(path.join(publicRoot, 'licenses/manifest.json'), 'utf8'));
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const ids = new Set();
assert.equal(manifest.schemaVersion, 1);
assert.ok(manifest.components.length > 200);
for (const [relative, hash] of Object.entries(manifest.inputs)) {
  assert.match(relative, /^(?:package-lock\.json|public\/lib\/vendor-manifest\.json|src-tauri\/Cargo\.lock|rai-agent\/Cargo\.lock)$/);
  assert.equal(digest(fs.readFileSync(path.join(root, relative), 'utf8').replace(/\r\n/g, '\n')), hash, `license inventory is stale for ${relative}`);
}
for (const component of manifest.components) {
  assert.ok(component.name && component.version && typeof component.license === 'string');
  assert.ok(!ids.has(component.id), `duplicate component: ${component.id}`);
  ids.add(component.id);
  const source = new URL(component.source);
  assert.equal(source.protocol, 'https:');
  assert.equal(source.username, '');
  assert.equal(source.password, '');
  assert.ok(component.notices.length, `${component.name} has no full notice`);
  let completeDocument = false;
  for (const notice of component.notices) {
    assert.match(notice.path, /^texts\/[a-f0-9]{64}\.txt$/);
    const buffer = fs.readFileSync(path.join(publicRoot, 'licenses', notice.path));
    assert.equal(digest(buffer), notice.sha256, `${component.name} notice checksum changed`);
    assert.equal(path.basename(notice.path), `${notice.sha256}.txt`);
    assert.ok(buffer.length > 0, `${component.name} has an empty notice`);
    completeDocument ||= buffer.length > 100;
  }
  assert.ok(completeDocument, `${component.name} only has a license label, not a full notice`);
}
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const runtime = Object.entries(lock.packages).filter(([location, entry]) => location && !entry.dev && !entry.link);
const npmComponents = manifest.components.filter(component => component.id.startsWith('npm-'));
assert.equal(npmComponents.length, runtime.length);
for (const [location, entry] of runtime) {
  const component = npmComponents.find(candidate => candidate.dependencyPath === location);
  assert.ok(component, `production dependency missing: ${location}`);
  assert.equal(component.version, entry.version);
  assert.equal(component.integrity, entry.integrity || '');
}
const vendors = JSON.parse(fs.readFileSync(path.join(publicRoot, 'lib/vendor-manifest.json'), 'utf8'));
assert.equal(manifest.components.filter(component => component.scope === 'browser').length, vendors.components.length);
for (const component of manifest.components.filter(component => component.scope === 'font')) {
  assert.equal(component.license, 'OFL-1.1');
  for (const file of component.files) assert.equal(digest(fs.readFileSync(path.join(publicRoot, file.path))), file.sha256);
}
for (const relative of ['src-tauri/Cargo.lock', 'rai-agent/Cargo.lock']) {
  const lockText = fs.readFileSync(path.join(root, relative), 'utf8');
  const crates = [...lockText.matchAll(/\[\[package\]\]\s+name = "([^"]+)"\s+version = "([^"]+)"\s+source = "registry\+[^\n]+"\s+checksum = "([a-f0-9]+)"/g)];
  assert.ok(crates.length > 100);
  for (const [, name, version, checksum] of crates) {
    const component = manifest.components.find(candidate => candidate.id === `cargo-${name}-${version}`);
    assert.ok(component, `Cargo license missing: ${name} ${version}`);
    assert.equal(component.archiveSha256, checksum);
  }
}
const blowfish = manifest.components.find(component => component.id === 'bcrypt-openbsd-blowfish');
assert.ok(blowfish.notices.some(notice => fs.readFileSync(path.join(publicRoot, 'licenses', notice.path), 'utf8').includes('This product includes software developed by Niels Provos.')));
assert.ok(ids.has('sqlite-embedded'));
assert.ok(ids.has('node-runtime'));
const index = fs.readFileSync(path.join(publicRoot, 'index.html'), 'utf8');
assert.match(index, /<details class="third-party-notices" data-third-party-notices>/, 'about licenses must be collapsed by default');
const ui = fs.readFileSync(path.join(publicRoot, 'third-party-notices.js'), 'utf8');
assert.ok(!ui.includes('innerHTML'), 'upstream license text must not become executable HTML');
const serviceWorker = fs.readFileSync(path.join(publicRoot, 'sw.js'), 'utf8');
assert.ok(serviceWorker.includes("'licenses/manifest.json'"));
assert.ok(serviceWorker.includes("url.pathname === appPath('third-party-notices.html')"));
console.log(`third-party licenses: ${manifest.components.length} component records, complete npm/Cargo/vendor/font coverage and notice digests passed`);
