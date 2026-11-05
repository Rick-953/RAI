#!/usr/bin/env python3
"""Install the same pinned, licensed Office resources shipped by CX RAI."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import sys
import tempfile
import zipfile


def prepare(source, destination):
    source, destination = Path(source), Path(destination)
    manifest = (source / 'sources.json').read_bytes()
    identity = hashlib.sha256(manifest).hexdigest()
    if (destination / '.ready').is_file():
        if (destination / '.ready').read_text() != identity:
            raise ValueError('office_resource_version_conflict')
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix='office-', dir=destination.parent))
    for item in json.loads(manifest)['archives']:
        archive = source / item['archive']
        if hashlib.sha256(archive.read_bytes()).hexdigest() != item['sha256']:
            raise ValueError('office_resource_digest_mismatch')
        root = staging / item['name']
        with zipfile.ZipFile(archive) as package:
            if len(package.infolist()) != item['fileCount']:
                raise ValueError('office_resource_count_mismatch')
            for entry in package.infolist():
                name = PurePosixPath(entry.filename.replace('\\', '/'))
                if name.is_absolute() or '..' in name.parts or ':' in entry.filename or (entry.external_attr >> 16) & 0o170000 == 0o120000:
                    raise ValueError('office_resource_path_invalid')
                target = root.joinpath(*name.parts)
                if entry.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(package.read(entry))
                    target.chmod(0o644)
    (staging / '.ready').write_text(identity)
    for folder, _, _ in os.walk(staging):
        Path(folder).chmod(0o755)
    staging.rename(destination)


if __name__ == '__main__':
    prepare(*sys.argv[1:])
