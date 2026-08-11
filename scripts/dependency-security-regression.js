'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const packageLock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
const vendorManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'lib', 'vendor-manifest.json'), 'utf8'));
const securityWorkflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'security.yml'), 'utf8');
const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const busboyMultipartSource = fs.readFileSync(path.join(ROOT, 'node_modules', 'busboy', 'lib', 'types', 'multipart.js'), 'utf8');

assert.equal(packageJson.version, packageLock.version, 'package-lock top-level version must equal package version');
assert.equal(packageJson.version, packageLock.packages?.['']?.version, 'package-lock root package version must equal package version');
assert.equal(packageJson.packageManager, 'npm@11.13.0', 'npm release toolchain must remain exact');
assert.deepEqual(packageJson.engines, { node: '24.16.0', npm: '11.13.0' }, 'Node/npm release engines must remain exact');
assert.deepEqual(packageLock.packages?.['']?.engines, packageJson.engines, 'lockfile release engines must mirror package.json');

function lockedVersions(packageName) {
  const suffix = `node_modules/${packageName}`;
  return Object.entries(packageLock.packages || {})
    .filter(([location, metadata]) => (
      (location === suffix || location.endsWith(`/${suffix}`))
      && metadata
      && typeof metadata.version === 'string'
    ))
    .map(([location, metadata]) => ({ location, version: metadata.version }));
}

function workflowJob(name) {
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return securityWorkflow.match(new RegExp(`^  ${escaped}:[\\s\\S]*?(?=^  [a-zA-Z0-9_-]+:|(?![\\s\\S]))`, 'm'))?.[0] || '';
}

assert.equal(packageJson.overrides?.tar, '7.5.22', 'node-tar must stay on the audited patched release');
assert.equal(packageJson.overrides?.['body-parser'], '1.20.6', 'body-parser must stay on the audited patched release');

for (const [name, exactVersion] of [['tar', '7.5.22'], ['body-parser', '1.20.6']]) {
  const locked = lockedVersions(name);
  assert.ok(locked.length > 0, `${name} must be present in package-lock.json`);
  for (const entry of locked) {
    assert.equal(entry.version, exactVersion, `${entry.location} resolved to unexpected ${name} ${entry.version}`);
  }
}

for (const [name, exactVersion] of [['multer', '2.2.0'], ['busboy', '1.6.0']]) {
  const locked = lockedVersions(name);
  assert.ok(locked.length > 0, `${name} must be present in package-lock.json`);
  for (const entry of locked) {
    assert.equal(entry.version, exactVersion, `${entry.location} resolved to unexpected ${name} ${entry.version}`);
  }
}
assert.match(busboyMultipartSource, /const MAX_HEADER_PAIRS = 2000;/, 'Busboy multipart part headers must have a finite pair bound');
assert.match(busboyMultipartSource, /const MAX_HEADER_SIZE = 16 \* 1024;/, 'Busboy multipart part headers must have a 16 KiB byte bound');
assert.doesNotMatch(serverSource, /headerPairs\s*:/, 'Multer must not claim that Busboy honors an unsupported headerPairs option');

const expectedVendors = new Map([
  ['dompurify', '3.4.12'],
  ['katex', '0.16.47']
]);
for (const [name, expectedVersion] of expectedVendors) {
  const component = vendorManifest.components?.find((entry) => entry.name === name);
  assert.ok(component, `missing vendored ${name}`);
  assert.equal(component.version, expectedVersion, `${name} must stay on its audited patched release`);
}

assert.match(packageJson.scripts?.['test:formal-audit'] || '', /npm run test:vendor-integrity/);
assert.match(packageJson.scripts?.['test:formal-audit'] || '', /npm run test:generated-image-cleanup/);
assert.match(packageJson.scripts?.['test:formal-audit'] || '', /npm run test:network-address-policy/);
assert.match(packageJson.scripts?.['test:formal-audit'] || '', /npm run test:security-config/);
assert.match(packageJson.scripts?.['test:formal-audit'] || '', /npm run security:smoke:isolated/);
assert.match(securityWorkflow, /npm run sbom:vendored-web/);
const osvJob = securityWorkflow.match(/^  osv-audit:[\s\S]*?(?=^  rustsec-audit:)/m)?.[0] || '';
const vendorSbomIndex = osvJob.indexOf('npm run sbom:vendored-web');
const osvScannerIndex = osvJob.indexOf('google/osv-scanner-action/osv-scanner-action@');
assert.ok(vendorSbomIndex >= 0 && osvScannerIndex > vendorSbomIndex, 'OSV must generate and scan the vendored SBOM in the same job');
assert.match(osvJob, /--recursive[\s\S]*?\.\//, 'OSV must recursively discover the generated .cdx.json SBOM');
const requiredPackageGates = [
  'formal-tests',
  'isolated-security-smoke',
  'dependency-audit',
  'osv-audit',
  'rustsec-audit',
  'codeql',
  'secret-scan'
];
const gateSummaryJob = workflowJob('security-gate-summary');
const summaryNeeds = gateSummaryJob.match(/^    needs:\s*\[([^\]]+)\]/m)?.[1] || '';
for (const gate of requiredPackageGates) {
  assert.ok(summaryNeeds.split(',').map((value) => value.trim()).includes(gate), `security gate summary must wait for ${gate}`);
}
assert.match(gateSummaryJob, /if:\s*always\(\)/, 'security gate summary must run even when an upstream gate fails');
assert.match(gateSummaryJob, /if \[\[ "\$result" != "success" \]\]; then/, 'security gate summary must fail closed');
const packageJob = workflowJob('package-web-release');
const rebuildJob = workflowJob('rebuild-web-release');
const reproducibilityJob = workflowJob('verify-reproducible-web-release');
const provenanceJob = workflowJob('attest-web-release-provenance');
const sbomProvenanceJob = workflowJob('attest-sbom-provenance');
const releaseJob = workflowJob('stage-github-release');
assert.match(packageJob, /^    needs:\s*security-gate-summary$/m, 'release package must wait for the fail-closed security gate summary');
assert.match(rebuildJob, /^    needs:\s*security-gate-summary$/m, 'independent rebuild must wait for the fail-closed security gate summary');
for (const [label, job] of [['primary build', packageJob], ['independent rebuild', rebuildJob]]) {
  assert.match(job, /git archive --format=tar --prefix=/, `${label} must build from the checked-out Git object`);
  assert.match(job, /\.env\.example LICENSE README\.md README\.zh-CN\.md RAI文档\.txt 更新运维\.txt/, `${label} must use the documented release allowlist`);
  assert.match(job, /agent lib workers public scripts server\.js user-session-token\.js package\.json package-lock\.json/, `${label} must include the complete Web runtime allowlist`);
  assert.match(job, /\| gzip -n >/, `${label} must suppress gzip timestamps`);
  assert.match(job, /sha256sum -c SHA256SUMS/, `${label} must validate its own checksum`);
}
assert.match(packageJob, /^\s*name:\s*rai-web-release$/m, 'primary build must upload only the primary artifact name');
assert.match(rebuildJob, /^\s*name:\s*rai-web-release-rebuild$/m, 'independent rebuild must use a distinct artifact name');
assert.match(reproducibilityJob, /^    needs:\s*\[package-web-release, rebuild-web-release\]$/m, 'reproducibility gate must wait for both clean builds');
assert.match(reproducibilityJob, /cmp -- "\$\{primary_archives\[0\]\}" "\$\{rebuilt_archives\[0\]\}"/, 'reproducibility gate must compare archive bytes');
assert.match(reproducibilityJob, /cmp -- primary-release\/SHA256SUMS rebuilt-release\/SHA256SUMS/, 'reproducibility gate must compare checksum manifests');
assert.match(reproducibilityJob, /^\s*name:\s*rai-web-release-verified$/m, 'reproducibility gate must publish a distinct verified artifact');
for (const [label, job] of [
  ['provenance attestation', provenanceJob],
  ['SBOM attestation', sbomProvenanceJob]
]) {
  assert.match(job, /^    needs:\s*verify-reproducible-web-release$/m, `${label} must wait for independent reproduction`);
  assert.match(job, /^\s*name:\s*rai-web-release-verified$/m, `${label} must consume only the verified artifact`);
  assert.doesNotMatch(job, /^\s*name:\s*rai-web-release$/m, `${label} must not consume the unverified primary artifact`);
  assert.doesNotMatch(job, /^\s*name:\s*rai-web-release-rebuild$/m, `${label} must not consume the unverified rebuild artifact`);
}
assert.match(releaseJob, /^\s*name:\s*rai-web-release-verified$/m, 'GitHub Release staging must consume only the independently verified artifact');
assert.doesNotMatch(releaseJob, /^\s*name:\s*rai-web-release$/m, 'GitHub Release staging must not consume an unverified artifact');
assert.equal((releaseJob.match(/require_tag_bound_to_workflow_commit/g) || []).length, 3, 'release staging must define tag binding and check it both before and after upload');

const actionUses = [...securityWorkflow.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)].map((match) => match[1]);
assert.ok(actionUses.length > 0, 'security workflow must use pinned actions');
for (const action of actionUses) {
  const separator = action.lastIndexOf('@');
  assert.ok(separator > 0, `action must include a revision: ${action}`);
  assert.match(action.slice(separator + 1), /^[0-9a-f]{40}$/, `action must be pinned to a full commit SHA: ${action}`);
}
assert.match(securityWorkflow, /^defaults:\s*\n\s{2}run:\s*\n\s{4}(?:#[^\n]*\n\s{4})*shell:\s*bash$/m, 'workflow pipelines must use explicit bash with pipefail');
assert.match(securityWorkflow, /^\s{2}NODE_VERSION:\s*24\.16\.0$/m, 'CI must exercise the production Node release');
assert.match(securityWorkflow, /^\s{2}NPM_VERSION:\s*11\.13\.0$/m, 'CI must exercise the production npm release');
assert.match(securityWorkflow, /test "\$\(node --version\)" = "v\$\{NODE_VERSION\}"/, 'CI must verify the resolved Node version');
assert.match(securityWorkflow, /test "\$\(npm --version\)" = "\$NPM_VERSION"/, 'CI must verify the resolved npm version');

console.log(JSON.stringify({
  dependencySecurityRegression: 'passed',
  tar: lockedVersions('tar'),
  bodyParser: lockedVersions('body-parser')
}));
