#!/usr/bin/env python3
"""Generate distributable notices from pinned lockfiles, never from API secrets.

Requires Python 3.11+. npm ci must have populated node_modules. Registry archives
are checked against Cargo.lock checksums; --check compares generated output.
Downloaded source archives stay in the OS temporary directory, outside Git.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import io
import json
import os
from pathlib import Path
import re
import tarfile
import tempfile
import time
import tomllib
import urllib.request
import urllib.error
import zipfile

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'public' / 'licenses'
CACHE = Path(tempfile.gettempdir()) / 'rai-notice-sources-v1'
LEGAL = re.compile(r'^(?:licen[cs]e|copying|notice|copyright|unlicense)(?:[._-]|$)', re.I)
FONT_COMMIT = '6c1dbe27dcf7d817d4b62cec033ba77fa8e2a5ec'
SHARP_LIBVIPS_COMMIT = 'ebb95f8add54eee8bed840e3fb587e4cbec857d7'  # v1.3.4 / libvips 8.18.7
GNULIB_COMMIT = 'f721a23f9a17f4e5b71361bd5c9a6c7aaf15533d'
components: list[dict] = []
texts: dict[str, bytes] = {}


def download(url: str, checksum: str | None = None) -> bytes:
    if not url.startswith('https://'):
        raise ValueError(f'HTTPS source required: {url}')
    CACHE.mkdir(exist_ok=True)
    cache_path = CACHE / hashlib.sha256(url.encode()).hexdigest()
    if cache_path.exists():
        value = cache_path.read_bytes()
    else:
        for attempt in range(3):
            try:
                request = urllib.request.Request(url, headers={'User-Agent': 'RAI-license-generation/1'})
                with urllib.request.urlopen(request, timeout=25) as response:
                    value = response.read(40 * 1024 * 1024 + 1)
                if len(value) > 40 * 1024 * 1024:
                    raise ValueError(f'Archive too large: {url}')
                cache_path.write_bytes(value)
                break
            except Exception as error:
                if isinstance(error, urllib.error.HTTPError) and 400 <= error.code < 500:
                    raise
                if attempt == 2:
                    raise
                time.sleep(attempt + 1)
    if checksum and hashlib.sha256(value).hexdigest() != checksum:
        raise ValueError(f'Archive checksum differs from lockfile: {url}')
    return value


def notice(name: str, content: str | bytes) -> dict:
    raw = content.encode('utf-8') if isinstance(content, str) else content
    # Decode early so a binary file can never silently become a license document.
    raw.decode('utf-8-sig')
    digest = hashlib.sha256(raw).hexdigest()
    relative = f'texts/{digest}.txt'
    texts[relative] = raw
    return {'name': name, 'path': relative, 'sha256': digest}


def safe_source(value: object, fallback: str) -> str:
    if isinstance(value, dict):
        value = value.get('url')
    if not isinstance(value, str):
        return fallback
    value = re.sub(r'^git\+', '', value)
    value = re.sub(r'^git://github.com/', 'https://github.com/', value)
    return value.removesuffix('.git') if value.startswith('https://') else fallback


def add_npm() -> None:
    lock = json.loads((ROOT / 'package-lock.json').read_text(encoding='utf-8'))
    for location, entry in sorted(lock['packages'].items()):
        if not location or entry.get('dev') or entry.get('link'):
            continue
        directory = ROOT / location
        package = json.loads((directory / 'package.json').read_text(encoding='utf-8'))
        name, version = package['name'], entry['version']
        if package['version'] != version:
            raise ValueError(f'npm ci required; version mismatch: {location}')
        legal_files = []
        for directory_name, children, files in os.walk(directory):
            children[:] = sorted(child for child in children if child not in ('node_modules', '.git', 'build', 'test', 'tests', 'examples', 'prebuilds'))
            for filename in sorted(files):
                if LEGAL.match(filename):
                    file = Path(directory_name) / filename
                    legal_files.append(notice(file.relative_to(directory).as_posix(), file.read_bytes()))
        if name.startswith('@img/sharp-'):
            # libvips npm binaries publish their legal inventory in the source
            # release README rather than a LICENSE file. Include that upstream
            # inventory plus the full LGPL/GPL terms, including static Windows/WASM builds.
            if name.startswith('@img/sharp-libvips-') and version != '1.3.4':
                raise ValueError(f'Update pinned libvips notices for {name} {version}')
            documents = [
                ('libvips bundled third-party notices', f'https://raw.githubusercontent.com/lovell/sharp-libvips/{SHARP_LIBVIPS_COMMIT}/THIRD-PARTY-NOTICES.md', '6f0d5086e3bcbee12bcdacf5878b31d1104002aeecaeb241d3fff466108082fe'),
                ('libvips LGPL 2.1 or later', 'https://raw.githubusercontent.com/libvips/libvips/v8.18.7/LICENSE', 'dc626520dcd53a22f727af3ee42c770e56c97a64fe3adb063799d8ab032fe551'),
                ('GNU LGPL 3', f'https://raw.githubusercontent.com/coreutils/gnulib/{GNULIB_COMMIT}/doc/COPYING.LESSERv3', 'e3a994d82e644b03a792a930f574002658412f62407f5fee083f2555c5f23118'),
                ('GNU GPL 3 incorporated by LGPL 3', f'https://raw.githubusercontent.com/coreutils/gnulib/{GNULIB_COMMIT}/doc/COPYINGv3', '3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986'),
            ]
            legal_files.extend(notice(title, download(url, checksum)) for title, url, checksum in documents)
        if not legal_files:
            raise ValueError(f'Complete upstream license missing: {location}')
        components.append({
            'id': 'npm-' + hashlib.sha256(location.encode()).hexdigest()[:16],
            'name': name, 'version': version, 'license': entry.get('license') or package.get('license', 'See included license'),
            'source': safe_source(package.get('repository'), f'https://www.npmjs.com/package/{name}/v/{version}'),
            'scope': 'server', 'dependencyPath': location,
            'integrity': entry.get('integrity', ''), 'sourceArchive': entry.get('resolved', ''), 'notices': legal_files,
        })


def add_embedded_runtime_notices() -> None:
    # Native source notices can carry additional terms not present in the npm
    # package's top-level license (notably OpenBSD's Blowfish implementation).
    directory = ROOT / 'node_modules/bcrypt/src'
    legal_files = []
    for filename in ['bcrypt.cc', 'blowfish.cc', 'node_blf.h']:
        source = (directory / filename).read_text(encoding='utf-8')
        headers = re.findall(r'/\*.*?\*/', source, re.S)
        copyright_headers = [header for header in headers if re.search(r'Copyright|Redistribution', header)]
        if not copyright_headers:
            raise ValueError(f'bcrypt source notice missing: {filename}')
        legal_files.append(notice(filename + ' copyright notice', '\n\n'.join(copyright_headers)))
    components.append({
        'id': 'bcrypt-openbsd-blowfish', 'name': 'OpenBSD bcrypt / Blowfish (inside bcrypt)',
        'version': 'bcrypt 6.0.0 sources', 'license': 'ISC AND BSD-4-Clause',
        'source': 'https://github.com/kelektiv/node.bcrypt.js/tree/v6.0.0/src', 'scope': 'server',
        'notices': legal_files,
    })
    sqlite_archive = next((ROOT / 'node_modules/sqlite3/deps').glob('sqlite-autoconf-*.tar.gz'))
    with tarfile.open(sqlite_archive) as archive:
        header = archive.extractfile(next(member for member in archive.getmembers() if member.name.endswith('/sqlite3.h'))).read().decode('utf-8')
        version = re.search(r'^#define SQLITE_VERSION\s+"([^"]+)"', header, re.M).group(1)
        statement = header[:header.index('*************************************************************************')].rstrip() + '\n*/\n'
    components.append({
        'id': 'sqlite-embedded', 'name': 'SQLite (inside sqlite3)', 'version': version,
        'license': 'Public domain', 'source': 'https://sqlite.org/copyright.html', 'scope': 'server',
        'notices': [notice('SQLite author copyright disclaimer and blessing', statement)],
    })
    node_version = json.loads((ROOT / 'package.json').read_text())['engines']['node']
    components.append({
        'id': 'node-runtime', 'name': 'Node.js hosted runtime', 'version': node_version,
        'license': 'MIT and included third-party licenses', 'source': f'https://github.com/nodejs/node/tree/v{node_version}',
        'scope': 'server', 'notices': [notice('Node.js LICENSE and bundled third-party notices', download(f'https://raw.githubusercontent.com/nodejs/node/v{node_version}/LICENSE'))],
    })


def add_browser() -> None:
    manifest = json.loads((ROOT / 'public/lib/vendor-manifest.json').read_text())
    for item in manifest['components']:
        legal_files = [notice(Path(relative).name, (ROOT / 'public/lib' / relative).read_bytes())
                       for relative in item['roots'] if relative.startswith('licenses/')]
        components.append({
            'id': 'browser-' + re.sub(r'[^a-z0-9]+', '-', item['name'].lower()),
            'name': item['name'], 'version': item['version'], 'license': item['license'],
            'source': item['source'], 'scope': 'browser', 'notices': legal_files,
        })
    for family in ['elmssans', 'notosanssc', 'notosanstc']:
        base = f'https://raw.githubusercontent.com/google/fonts/{FONT_COMMIT}/ofl/{family}/'
        # Keep exact source URL + digest in the generated index. Subsequent --check
        # uses the cached upstream bytes rather than changing an accepted notice.
        license_text = download(base + 'OFL.txt')
        metadata = download(base + 'METADATA.pb').decode('utf-8')
        name = re.search(r'^name: "([^"]+)"', metadata, re.M).group(1)
        font_directory = {'elmssans': 'elms-sans', 'notosanssc': 'noto-sans-sc', 'notosanstc': 'noto-sans-tc'}[family]
        files = sorted((ROOT / 'public/fonts' / font_directory).rglob('*.ttf'))
        if not files:
            raise ValueError(f'Font not found: {family}')
        components.append({
            'id': 'font-' + family, 'name': name, 'version': 'bundled v1', 'license': 'OFL-1.1',
            'source': f'https://github.com/google/fonts/tree/{FONT_COMMIT}/ofl/{family}', 'scope': 'font',
            'files': [{'path': f.relative_to(ROOT / 'public').as_posix(), 'sha256': hashlib.sha256(f.read_bytes()).hexdigest()} for f in files],
            'notices': [notice('OFL.txt', license_text)],
        })
    # KaTeX's own upstream license explicitly includes its font assets.


def crate_component(item: dict) -> dict:
    name, version = item['name'], item['version']
    url = f'https://static.crates.io/crates/{name}/{name}-{version}.crate'
    data = download(url, item['checksum'])
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        prefix = f'{name}-{version}/'
        legal_files, package, readme, vcs = [], None, None, None
        for member in archive.getmembers():
            if not member.isfile() or not member.name.startswith(prefix) or member.size > 2 * 1024 * 1024:
                continue
            relative = member.name[len(prefix):]
            if relative == 'Cargo.toml':
                package = tomllib.loads(archive.extractfile(member).read().decode('utf-8'))['package']
            if relative == '.cargo_vcs_info.json':
                vcs = json.loads(archive.extractfile(member).read().decode('utf-8'))
            if LEGAL.match(Path(relative).name):
                legal_files.append((relative, archive.extractfile(member).read()))
            if relative.lower() in ('readme.md', 'readme', 'readme.rst'):
                readme = (relative, archive.extractfile(member).read())
        if package is None:
            raise ValueError(f'No Cargo.toml: {name} {version}')
        if package.get('license-file'):
            filename = package['license-file']
            if not any(filename == n for n, _ in legal_files):
                legal_files.append((filename, archive.extractfile(prefix + filename).read()))
        if not legal_files:
            repository = safe_source(package.get('repository'), '')
            if repository.startswith('https://github.com/') and vcs and vcs.get('git', {}).get('sha1'):
                # Some workspace crates omit the root license from their .crate.
                # Recover it from the exact published source commit, not HEAD.
                source = repository[len('https://github.com/'):].split('/')[:2]
                commit = vcs['git']['sha1']
                for filename in ['LICENSE', 'LICENSE.txt', 'LICENSE.md', 'COPYING', 'LICENSE-MIT', 'LICENSE-APACHE']:
                    try:
                        legal_files.append((f'upstream/{commit}/{filename}', download(f'https://raw.githubusercontent.com/{"/".join(source)}/{commit}/{filename}')))
                    except urllib.error.HTTPError as error:
                        if error.code != 404:
                            raise
            if not legal_files:
                # The SPDX expression is an upstream declaration, not a guessed
                # license. Keep the exact manifest/authors and standardized full
                # text when an upstream crate omitted a standalone license file.
                expression = package.get('license', '')
                identifiers = [part for part in re.split(r'[()\s/]+', expression) if part and part not in ('OR', 'AND', 'WITH')]
                if not identifiers:
                    raise ValueError(f'Complete license text missing: {name} {version}')
                legal_files.append(('Published package authors and license declaration', json.dumps({key: package[key] for key in ('name', 'version', 'authors', 'license', 'repository') if key in package}, ensure_ascii=False, indent=2).encode()))
                if readme:
                    legal_files.append(readme)
                for identifier in identifiers:
                    value = download(f'https://raw.githubusercontent.com/spdx/license-list-data/v3.27.0/text/{identifier}.txt')
                    legal_files.append((f'SPDX-{identifier}.txt', value))
        return {
            'id': f'cargo-{name}-{version}', 'name': name, 'version': version,
            'license': package.get('license', 'See included license'),
            'source': safe_source(package.get('repository'), f'https://crates.io/crates/{name}/{version}'),
            'scope': 'desktop-agent', 'usedBy': item['usedBy'], 'archiveSha256': item['checksum'],
            'sourceArchive': url,
            '_raw_notices': sorted(legal_files),
        }


def add_cargo() -> None:
    crates = {}
    for target, relative in [('RAI Desktop', 'src-tauri/Cargo.lock'), ('RAI Local Agent', 'rai-agent/Cargo.lock')]:
        for item in tomllib.loads((ROOT / relative).read_text())['package']:
            if not item.get('source', '').startswith('registry+'):
                continue
            key = (item['name'], item['version'])
            if key not in crates:
                crates[key] = {**item, 'usedBy': []}
            crates[key]['usedBy'].append(target)
    errors = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
        completed = 0
        futures = {executor.submit(crate_component, item): item for item in crates.values()}
        for future in concurrent.futures.as_completed(futures):
            try:
                component = future.result()
            except Exception as error:
                item = futures[future]
                errors.append(f'{item["name"]} {item["version"]}: {error}')
                continue
            component['notices'] = [notice(n, content) for n, content in component.pop('_raw_notices')]
            components.append(component)
            completed += 1
            if completed % 100 == 0:
                print(f'Collected Cargo notices {completed}/{len(crates)}', flush=True)
    if errors:
        raise ValueError('Failed source collection:\n' + '\n'.join(errors))


def add_office_resources() -> None:
    root = ROOT / 'skills/office-resources'
    for item in json.loads((root / 'sources.json').read_text(encoding='utf-8'))['archives']:
        archive = root / item['archive']
        if hashlib.sha256(archive.read_bytes()).hexdigest() != item['sha256']:
            raise ValueError(f'Office resource digest mismatch: {archive.name}')
        with zipfile.ZipFile(archive) as bundle:
            for component in item['components']:
                prefix = {'hermes-office': 'hermes/', 'bread': 'bread/'}.get(component['name'], '')
                legal = [name for name in bundle.namelist() if name.startswith(prefix) and '/' not in name[len(prefix):] and LEGAL.match(name[len(prefix):])]
                if not legal:
                    raise ValueError(f'Office license missing: {component["name"]}')
                components.append({'id': 'office-' + component['name'], 'name': component['name'], 'version': component['commit'],
                    'license': component['license'], 'source': component['source'], 'scope': 'office-skill',
                    'archiveSha256': item['sha256'], 'notices': [notice(name, bundle.read(name)) for name in sorted(legal)]})


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    arguments = parser.parse_args()
    add_npm()
    add_embedded_runtime_notices()
    add_browser()
    add_cargo()
    add_office_resources()
    components.sort(key=lambda item: (item['scope'], item['name'].lower(), item['version'], item['id']))
    manifest = {
        'schemaVersion': 1, 'product': 'RAI Web',
        'scopeNote': 'Production npm lock dependencies; browser libraries and fonts; all locked Cargo dependencies for the optional RAI Desktop and Local Agent, including build and target-specific crates. Development-only npm tools are excluded. Brand names and logos belong to their respective owners.',
        'inputs': {relative: hashlib.sha256((ROOT / relative).read_bytes().replace(b'\r\n', b'\n')).hexdigest() for relative in ['package-lock.json', 'public/lib/vendor-manifest.json', 'src-tauri/Cargo.lock', 'rai-agent/Cargo.lock']},
        'components': components,
    }
    outputs = {**texts, 'manifest.json': (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode('utf-8')}
    if arguments.check:
        for relative, value in outputs.items():
            file = OUTPUT / relative
            if not file.is_file() or file.read_bytes() != value:
                raise ValueError(f'Generated notice out of date: {relative}')
    else:
        for relative, value in outputs.items():
            file = OUTPUT / relative
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(value)
        # Only remove files this generator owns, after validating they stay inside
        # public/licenses/texts. Shared/handwritten license files are untouched.
        text_root = (OUTPUT / 'texts').resolve()
        for file in text_root.glob('*.txt'):
            if file.resolve().parent == text_root and file.relative_to(OUTPUT).as_posix() not in outputs:
                file.unlink()
    print(f'{"Verified" if arguments.check else "Generated"} {len(components)} component records, {len(texts)} full notice files.', flush=True)


if __name__ == '__main__':
    main()
