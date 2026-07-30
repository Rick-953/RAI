'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const tar = require('tar');

const ROOT = path.resolve(__dirname, '..');
const LIB_ROOT = path.join(ROOT, 'public', 'lib');
const manifest = JSON.parse(fs.readFileSync(path.join(LIB_ROOT, 'vendor-manifest.json'), 'utf8'));
const MAX_TARBALL_BYTES = 25 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 100 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 5_000;
const REQUEST_TIMEOUT_MS = 20_000;

function digest(algorithm, value, encoding = 'hex') {
  return crypto.createHash(algorithm).update(value).digest(encoding);
}

function assertSafeRelativePath(value, label, requiredPrefix = '') {
  assert.equal(typeof value, 'string', `${label} must be a string`);
  assert.ok(value && !path.isAbsolute(value), `${label} must be relative`);
  assert.ok(!value.includes('\\') && !value.includes('\0'), `${label} contains unsafe characters`);
  const segments = value.split('/');
  assert.ok(segments.every((segment) => segment && segment !== '.' && segment !== '..'), `${label} escapes its root`);
  if (requiredPrefix) assert.ok(value.startsWith(requiredPrefix), `${label} must start with ${requiredPrefix}`);
}

function downloadPinnedTarball(component) {
  return new Promise((resolve, reject) => {
    const url = new URL(component.npmTarball);
    assert.equal(url.protocol, 'https:', `${component.name} tarball must use HTTPS`);
    assert.equal(url.hostname, 'registry.npmjs.org', `${component.name} tarball must use the npm registry`);
    assert.equal(url.username, '', `${component.name} tarball URL contains credentials`);
    assert.equal(url.password, '', `${component.name} tarball URL contains credentials`);

    const request = https.get(url, {
      headers: { 'User-Agent': 'RAI-vendor-provenance-gate/1' }
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`${component.name} tarball returned HTTP ${response.statusCode}`));
        return;
      }
      const declaredLength = Number(response.headers['content-length'] || 0);
      if (declaredLength > MAX_TARBALL_BYTES) {
        response.destroy(new Error(`${component.name} tarball exceeds the byte limit`));
        return;
      }
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_TARBALL_BYTES) {
          response.destroy(new Error(`${component.name} tarball exceeds the byte limit`));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    });
    request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error(`${component.name} tarball request timed out`)));
    request.on('error', reject);
  });
}

function verifySri(component, archive) {
  const match = component.npmIntegrity.match(/^sha512-([A-Za-z0-9+/]+={0,2})$/);
  assert.ok(match, `${component.name} has an invalid npm integrity value`);
  const expected = Buffer.from(match[1], 'base64');
  const actual = crypto.createHash('sha512').update(archive).digest();
  assert.equal(actual.length, expected.length, `${component.name} integrity length differs`);
  assert.ok(crypto.timingSafeEqual(actual, expected), `${component.name} tarball failed its pinned npm SRI`);
}

function readTarball(component, archive) {
  return new Promise((resolve, reject) => {
    const files = new Map();
    let expandedBytes = 0;
    let entryCount = 0;
    const parser = tar.t({
      strict: true,
      onentry(entry) {
        entryCount += 1;
        assert.ok(entryCount <= MAX_ARCHIVE_ENTRIES, `${component.name} archive has too many entries`);
        assertSafeRelativePath(entry.path, `${component.name} archive path`, 'package/');
        assert.ok(['File', 'OldFile', 'Directory'].includes(entry.type), `${component.name} archive contains ${entry.type}`);
        const chunks = [];
        let bytes = 0;
        entry.on('data', (chunk) => {
          bytes += chunk.length;
          expandedBytes += chunk.length;
          assert.ok(bytes <= MAX_TARBALL_BYTES, `${component.name} archive entry is too large`);
          assert.ok(expandedBytes <= MAX_EXPANDED_BYTES, `${component.name} archive expands past the total byte limit`);
          chunks.push(chunk);
        });
        entry.on('end', () => {
          if (entry.type === 'File' || entry.type === 'OldFile') {
            assert.ok(!files.has(entry.path), `${component.name} archive repeats ${entry.path}`);
            files.set(entry.path, Buffer.concat(chunks));
          }
        });
      }
    });
    parser.on('error', reject);
    parser.on('close', () => resolve(files));
    parser.end(archive);
  });
}

function collectLocalFiles(relativeRoot) {
  const absoluteRoot = path.join(LIB_ROOT, relativeRoot);
  const stat = fs.lstatSync(absoluteRoot);
  assert.ok(!stat.isSymbolicLink(), `vendored path is a symbolic link: ${relativeRoot}`);
  if (stat.isFile()) return [relativeRoot];
  assert.ok(stat.isDirectory(), `vendored path is special: ${relativeRoot}`);
  const files = [];
  function visit(absolutePath, relativePath) {
    for (const name of fs.readdirSync(absolutePath).sort()) {
      const childAbsolute = path.join(absolutePath, name);
      const childRelative = path.posix.join(relativePath, name);
      const childStat = fs.lstatSync(childAbsolute);
      assert.ok(!childStat.isSymbolicLink(), `vendored path is a symbolic link: ${childRelative}`);
      if (childStat.isDirectory()) visit(childAbsolute, childRelative);
      else {
        assert.ok(childStat.isFile(), `vendored path is special: ${childRelative}`);
        files.push(childRelative);
      }
    }
  }
  visit(absoluteRoot, relativeRoot);
  return files;
}

function mappedUpstreamPath(component, localPath) {
  const exact = component.upstreamFiles[localPath];
  const directoryMatches = Object.entries(component.upstreamDirectories)
    .filter(([localRoot]) => localPath.startsWith(`${localRoot}/`));
  assert.ok(!(exact && directoryMatches.length), `${component.name} maps ${localPath} more than once`);
  assert.ok(directoryMatches.length <= 1, `${component.name} maps ${localPath} through overlapping directories`);
  if (exact) return exact;
  if (directoryMatches.length === 1) {
    const [localRoot, upstreamRoot] = directoryMatches[0];
    return `${upstreamRoot}/${localPath.slice(localRoot.length + 1)}`;
  }
  throw new Error(`${component.name} has no upstream mapping for ${localPath}`);
}

function verifyMappings(component, upstreamFiles) {
  assert.ok(component.upstreamFiles && typeof component.upstreamFiles === 'object' && !Array.isArray(component.upstreamFiles), `${component.name} needs upstreamFiles`);
  assert.ok(component.upstreamDirectories && typeof component.upstreamDirectories === 'object' && !Array.isArray(component.upstreamDirectories), `${component.name} needs upstreamDirectories`);
  for (const [localPath, upstreamPath] of Object.entries(component.upstreamFiles)) {
    assertSafeRelativePath(localPath, `${component.name} local mapping`);
    assertSafeRelativePath(upstreamPath, `${component.name} upstream mapping`, 'package/');
  }
  for (const [localRoot, upstreamRoot] of Object.entries(component.upstreamDirectories)) {
    assertSafeRelativePath(localRoot, `${component.name} local directory mapping`);
    assertSafeRelativePath(upstreamRoot, `${component.name} upstream directory mapping`, 'package/');
  }

  const localFiles = component.roots.flatMap(collectLocalFiles).sort();
  assert.equal(new Set(localFiles).size, localFiles.length, `${component.name} roots overlap`);
  const expectedUpstream = new Set();
  for (const localPath of localFiles) {
    const upstreamPath = mappedUpstreamPath(component, localPath);
    assert.ok(!expectedUpstream.has(upstreamPath), `${component.name} maps two files to ${upstreamPath}`);
    expectedUpstream.add(upstreamPath);
    assert.ok(upstreamFiles.has(upstreamPath), `${component.name} upstream tarball is missing ${upstreamPath}`);
    const localBytes = fs.readFileSync(path.join(LIB_ROOT, localPath));
    const upstreamBytes = upstreamFiles.get(upstreamPath);
    assert.ok(localBytes.equals(upstreamBytes), `${component.name} vendored bytes differ from ${upstreamPath}`);
  }

  for (const upstreamRoot of Object.values(component.upstreamDirectories)) {
    const archiveChildren = [...upstreamFiles.keys()].filter((value) => value.startsWith(`${upstreamRoot}/`)).sort();
    const mappedChildren = [...expectedUpstream].filter((value) => value.startsWith(`${upstreamRoot}/`)).sort();
    assert.deepStrictEqual(mappedChildren, archiveChildren, `${component.name} directory mapping omits or adds upstream files under ${upstreamRoot}`);
  }
  for (const localPath of Object.keys(component.upstreamFiles)) {
    assert.ok(localFiles.includes(localPath), `${component.name} exact mapping is not part of its vendored roots: ${localPath}`);
  }

  const packageMetadata = JSON.parse(upstreamFiles.get('package/package.json').toString('utf8'));
  assert.equal(packageMetadata.name, component.name, `${component.name} package name differs`);
  assert.equal(packageMetadata.version, component.version, `${component.name} package version differs`);
  assert.equal(typeof packageMetadata.license, 'string', `${component.name} upstream package has no license metadata`);
  const normalizeLicense = (value) => value
    .replace(/[()]/g, '')
    .split(/\s+OR\s+/i)
    .map((part) => part.trim())
    .filter(Boolean)
    .sort()
    .join(' OR ');
  assert.equal(normalizeLicense(packageMetadata.license), normalizeLicense(component.license), `${component.name} license expression differs`);

  return {
    name: component.name,
    version: component.version,
    files: localFiles.length
  };
}

async function main() {
  assert.equal(manifest.schemaVersion, 3, 'unsupported vendor manifest schema');
  assert.ok(Array.isArray(manifest.components) && manifest.components.length > 0, 'vendor manifest needs components');
  const results = [];
  for (const component of manifest.components) {
    const archive = await downloadPinnedTarball(component);
    verifySri(component, archive);
    const upstreamFiles = await readTarball(component, archive);
    assert.ok(upstreamFiles.has('package/package.json'), `${component.name} tarball has no package metadata`);
    const result = verifyMappings(component, upstreamFiles);
    result.tarballSha512 = digest('sha512', archive);
    results.push(result);
  }
  console.log(JSON.stringify({ vendorUpstreamProvenance: 'passed', components: results }, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
