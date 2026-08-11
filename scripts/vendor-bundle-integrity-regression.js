'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LIB_ROOT = path.join(ROOT, 'public', 'lib');
const MANIFEST_PATH = path.join(LIB_ROOT, 'vendor-manifest.json');
const NOTICE_PATH = path.join(LIB_ROOT, 'THIRD_PARTY_NOTICES.md');
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const excludedFiles = new Set(['THIRD_PARTY_NOTICES.md', 'vendor-manifest.json']);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function assertSafeRelativePath(relativePath) {
  assert.equal(typeof relativePath, 'string');
  assert.ok(relativePath && !path.isAbsolute(relativePath), `vendor root must be relative: ${relativePath}`);
  assert.ok(!relativePath.includes('\\'), `vendor root must use POSIX separators: ${relativePath}`);
  const segments = relativePath.split('/');
  assert.ok(segments.every((segment) => segment && segment !== '.' && segment !== '..'), `unsafe vendor root: ${relativePath}`);
}

function collectRegularFiles(relativeRoot) {
  assertSafeRelativePath(relativeRoot);
  const absoluteRoot = path.resolve(LIB_ROOT, relativeRoot);
  assert.ok(absoluteRoot.startsWith(`${LIB_ROOT}${path.sep}`), `vendor root escaped public/lib: ${relativeRoot}`);
  assert.ok(fs.existsSync(absoluteRoot), `vendored component is missing: ${relativeRoot}`);

  const files = [];
  function visit(absolutePath, relativePath) {
    const stat = fs.lstatSync(absolutePath);
    assert.ok(!stat.isSymbolicLink(), `vendored dependency contains a symbolic link: ${relativePath}`);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(absolutePath).sort()) {
        visit(path.join(absolutePath, entry), path.posix.join(relativePath, entry));
      }
      return;
    }
    assert.ok(stat.isFile(), `vendored dependency contains a special file: ${relativePath}`);
    files.push(relativePath);
  }

  visit(absoluteRoot, relativeRoot);
  return files.sort();
}

function componentIntegrity(component) {
  assert.ok(Array.isArray(component.roots) && component.roots.length > 0, `${component.name} needs declared roots`);
  const files = component.roots.flatMap((relativeRoot) => collectRegularFiles(relativeRoot)).sort();
  assert.equal(new Set(files).size, files.length, `${component.name} has overlapping roots`);
  let bytes = 0;
  const rows = files.map((relativePath) => {
    const buffer = fs.readFileSync(path.join(LIB_ROOT, relativePath));
    bytes += buffer.length;
    return `${relativePath}\0${sha256(buffer)}\n`;
  }).join('');
  return {
    files,
    fileCount: files.length,
    bytes,
    treeSha256: sha256(rows)
  };
}

assert.equal(manifest.schemaVersion, 3, 'unsupported vendor manifest schema');
assert.ok(Array.isArray(manifest.components) && manifest.components.length > 0, 'vendor manifest needs components');
assert.ok(fs.statSync(NOTICE_PATH).isFile(), 'third-party notice is missing');

const names = new Set();
const purls = new Set();
const claimedFiles = new Set();
for (const component of manifest.components) {
  assert.match(component.name, /^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/, 'invalid component name');
  assert.match(component.version, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, `${component.name} needs an exact semantic version`);
  assert.match(component.purl, /^pkg:npm\/[A-Za-z0-9@._%/-]+@\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, `${component.name} needs an exact npm purl`);
  assert.ok(component.purl.endsWith(`@${component.version}`), `${component.name} purl/version mismatch`);
  const encodedPurlName = component.purl.slice('pkg:npm/'.length, -(`@${component.version}`.length));
  assert.equal(decodeURIComponent(encodedPurlName), component.name, `${component.name} purl/package-name mismatch`);
  assert.ok(typeof component.license === 'string' && component.license.length > 0, `${component.name} needs a license expression`);
  const source = new URL(component.source);
  assert.equal(source.protocol, 'https:', `${component.name} source must use HTTPS`);
  assert.equal(source.username, '', `${component.name} source must not contain credentials`);
  assert.equal(source.password, '', `${component.name} source must not contain credentials`);
  const npmTarball = new URL(component.npmTarball);
  assert.equal(npmTarball.protocol, 'https:', `${component.name} tarball must use HTTPS`);
  assert.equal(npmTarball.hostname, 'registry.npmjs.org', `${component.name} tarball must use the npm registry`);
  assert.match(component.npmIntegrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/, `${component.name} needs npm SHA-512 integrity`);
  assert.ok(component.upstreamFiles && typeof component.upstreamFiles === 'object' && !Array.isArray(component.upstreamFiles), `${component.name} needs exact upstream file mappings`);
  assert.ok(component.upstreamDirectories && typeof component.upstreamDirectories === 'object' && !Array.isArray(component.upstreamDirectories), `${component.name} needs upstream directory mappings`);
  const mappedLocalPaths = [
    ...Object.keys(component.upstreamFiles),
    ...Object.keys(component.upstreamDirectories)
  ];
  assert.equal(new Set(mappedLocalPaths).size, mappedLocalPaths.length, `${component.name} repeats an upstream mapping root`);
  for (const [localPath, upstreamPath] of [
    ...Object.entries(component.upstreamFiles),
    ...Object.entries(component.upstreamDirectories)
  ]) {
    assertSafeRelativePath(localPath);
    assertSafeRelativePath(upstreamPath);
    assert.ok(upstreamPath.startsWith('package/'), `${component.name} upstream path must stay inside the npm package`);
  }
  assert.ok(!names.has(component.name), `duplicate component name: ${component.name}`);
  assert.ok(!purls.has(component.purl), `duplicate component purl: ${component.purl}`);
  names.add(component.name);
  purls.add(component.purl);

  const actual = componentIntegrity(component);
  for (const relativePath of actual.files) {
    const exactMapping = Object.prototype.hasOwnProperty.call(component.upstreamFiles, relativePath);
    const directoryMappings = Object.keys(component.upstreamDirectories)
      .filter((localRoot) => relativePath.startsWith(`${localRoot}/`));
    assert.equal(Number(exactMapping) + directoryMappings.length, 1, `${component.name} must map ${relativePath} to exactly one upstream path`);
  }
  assert.equal(actual.fileCount, component.fileCount, `${component.name} file count changed`);
  assert.equal(actual.bytes, component.bytes, `${component.name} byte count changed`);
  assert.equal(actual.treeSha256, component.treeSha256, `${component.name} tree digest changed`);
  assertSafeRelativePath(component.entrypoint);
  assert.ok(actual.files.includes(component.entrypoint), `${component.name} entrypoint is outside its roots`);
  assert.match(component.entrypointSha256, /^[a-f0-9]{64}$/, `${component.name} needs an entrypoint digest`);
  assert.equal(
    sha256(fs.readFileSync(path.join(LIB_ROOT, component.entrypoint))),
    component.entrypointSha256,
    `${component.name} entrypoint digest changed`
  );
  assert.ok(component.roots.some((root) => root.startsWith('licenses/')), `${component.name} must ship its license text`);
  if (component.modified === true) {
    assert.match(component.upstreamEntrypointSha256, /^[a-f0-9]{64}$/, `${component.name} needs its upstream digest`);
    assert.notEqual(component.upstreamEntrypointSha256, component.entrypointSha256, `${component.name} local patch is not reflected in its digest`);
    assert.ok(Array.isArray(component.localPatches) && component.localPatches.length > 0, `${component.name} needs local patch metadata`);
    for (const patch of component.localPatches) {
      assert.match(patch.id, /^RAI-[A-Z0-9-]+$/, `${component.name} patch needs a stable ID`);
      assert.ok(typeof patch.description === 'string' && patch.description.length >= 40, `${patch.id} needs a useful description`);
      assert.ok(Number.isInteger(patch.replacementCount) && patch.replacementCount > 0, `${patch.id} needs a replacement count`);
    }
  } else {
    assert.ok(!component.upstreamEntrypointSha256 && !component.localPatches, `${component.name} has undeclared modification metadata`);
  }
  for (const relativePath of actual.files) {
    assert.ok(!claimedFiles.has(relativePath), `vendored file is claimed twice: ${relativePath}`);
    claimedFiles.add(relativePath);
  }
}

function collectAllLibraryFiles() {
  const files = [];
  function visit(absolutePath, relativePath = '') {
    for (const entry of fs.readdirSync(absolutePath).sort()) {
      const childAbsolute = path.join(absolutePath, entry);
      const childRelative = relativePath ? path.posix.join(relativePath, entry) : entry;
      const stat = fs.lstatSync(childAbsolute);
      assert.ok(!stat.isSymbolicLink(), `public/lib contains a symbolic link: ${childRelative}`);
      if (stat.isDirectory()) {
        visit(childAbsolute, childRelative);
      } else {
        assert.ok(stat.isFile(), `public/lib contains a special file: ${childRelative}`);
        if (!excludedFiles.has(childRelative)) files.push(childRelative);
      }
    }
  }
  visit(LIB_ROOT);
  return files.sort();
}

const allLibraryFiles = collectAllLibraryFiles();
assert.deepStrictEqual(
  [...claimedFiles].sort(),
  allLibraryFiles,
  'every file under public/lib must belong to exactly one pinned component'
);

function buildCycloneDxBom() {
  const appRef = `pkg:npm/${packageJson.name}@${packageJson.version}`;
  const manifestSha256 = sha256(fs.readFileSync(MANIFEST_PATH));
  const serialHex = manifestSha256.slice(0, 32);
  const serialUuid = `${serialHex.slice(0, 8)}-${serialHex.slice(8, 12)}-4${serialHex.slice(13, 16)}-a${serialHex.slice(17, 20)}-${serialHex.slice(20, 32)}`;
  const components = manifest.components.map((component) => ({
    type: 'library',
    'bom-ref': component.purl,
    name: component.name,
    version: component.version,
    purl: component.purl,
    licenses: [{ expression: component.license }],
    externalReferences: [
      { type: 'vcs', url: component.source },
      { type: 'distribution', url: component.npmTarball }
    ],
    properties: [
      { name: 'rai:vendorRoots', value: JSON.stringify(component.roots) },
      { name: 'rai:entrypoint', value: component.entrypoint },
      { name: 'rai:entrypointSha256', value: component.entrypointSha256 },
      { name: 'rai:npmIntegrity', value: component.npmIntegrity },
      { name: 'rai:treeSha256', value: component.treeSha256 },
      { name: 'rai:fileCount', value: String(component.fileCount) },
      { name: 'rai:bytes', value: String(component.bytes) },
      { name: 'rai:modified', value: String(component.modified === true) },
      ...(component.modified === true ? [
        { name: 'rai:upstreamEntrypointSha256', value: component.upstreamEntrypointSha256 },
        { name: 'rai:localPatches', value: JSON.stringify(component.localPatches) }
      ] : [])
    ]
  }));
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${serialUuid}`,
    version: 1,
    metadata: {
      component: {
        type: 'application',
        'bom-ref': appRef,
        name: packageJson.name,
        version: packageJson.version,
        purl: appRef
      },
      properties: [
        { name: 'rai:vendorManifestSha256', value: manifestSha256 }
      ]
    },
    components,
    dependencies: [
      { ref: appRef, dependsOn: components.map((component) => component['bom-ref']) },
      ...components.map((component) => ({ ref: component['bom-ref'], dependsOn: [] }))
    ]
  };
}

const sbomFlagIndex = process.argv.indexOf('--sbom');
if (sbomFlagIndex !== -1) {
  const outputArg = process.argv[sbomFlagIndex + 1];
  assert.ok(outputArg, '--sbom needs an output path');
  const outputPath = path.resolve(process.cwd(), outputArg);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(buildCycloneDxBom(), null, 2)}\n`, { mode: 0o644 });
  JSON.parse(fs.readFileSync(outputPath, 'utf8'));
}

console.log(JSON.stringify({
  vendorBundleIntegrity: 'passed',
  components: manifest.components.map(({ name, version, treeSha256 }) => ({ name, version, treeSha256 })),
  files: allLibraryFiles.length
}));
