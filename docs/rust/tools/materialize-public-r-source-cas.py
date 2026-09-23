#!/usr/bin/env python3
"""Restore exact public R source bytes for source CI; never grants qualification.

The frozen pre-externalization subtree is a content authority, not proof that
an inaccessible companion gitlink commit has been checked out. No network,
package installation, archive extraction, or candidate source execution occurs.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tempfile

PUBLIC_TREE = 'd6b31b7145b97ae01c71e76b34ef7c5cb1a3e082'
MANIFEST_BLOB = '0053ff8c14a375874bc5c0ea4f0f6071d648b1eb'
ROOT = Path(__file__).resolve().parents[3]
TARGET = 'runtime-images/r-scientific/source-cas'
MAX_FILE = 32 * 1024 * 1024
MAX_TOTAL = 128 * 1024 * 1024


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError('public_r_source_cas_' + message)


def blob_hash(raw: bytes) -> str:
    return hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest()


def git(root: Path, *args: str) -> bytes:
    return subprocess.run(['/usr/bin/git', '-c', 'core.hooksPath=/dev/null',
        '-c', 'core.fsmonitor=false', *args], cwd=root, check=True,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30,
        env={'PATH': '/usr/bin:/bin', 'HOME': '/nonexistent',
             'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_NOSYSTEM': '1',
             'GIT_NO_REPLACE_OBJECTS': '1', 'GIT_OPTIONAL_LOCKS': '0'}).stdout


def capture(root: Path) -> dict[str, bytes]:
    require(git(root, 'rev-parse', PUBLIC_TREE + '^{tree}').decode().strip() == PUBLIC_TREE,
            'source_tree_unavailable')
    rows = git(root, 'ls-tree', '-rlz', PUBLIC_TREE).split(b'\0')[:-1]
    require(len(rows) == 107, 'source_inventory_invalid')
    result = {}
    total = 0
    for row in rows:
        metadata, raw_name = row.split(b'\t', 1)
        mode, kind, digest, size = metadata.decode('ascii').split()
        name = raw_name.decode('ascii')
        require(mode == '100644' and kind == 'blob', 'source_entry_type_invalid')
        require(bool(re.fullmatch(r'[A-Za-z0-9_.\-/]+', name))
                and all(part not in ('', '.', '..') for part in name.split('/')),
                'source_path_invalid')
        require(name not in result, 'source_duplicate')
        length = int(size)
        total += length
        require(0 <= length <= MAX_FILE and total <= MAX_TOTAL, 'source_byte_limit')
        raw = git(root, 'cat-file', 'blob', digest)
        require(len(raw) == length and blob_hash(raw) == digest, 'source_blob_mismatch')
        result[name] = raw
    validate_bundle(result)
    return result


def validate_bundle(files: dict[str, bytes]) -> None:
    require(len(files) == 107 and blob_hash(files.get('manifest.json', b'')) == MANIFEST_BLOB,
            'manifest_identity_mismatch')
    manifest = json.loads(files['manifest.json'])
    require(manifest['kind'] == 'RRuntimeSourceCasManifest'
            and manifest['status'] == 'r_runtime_source_cas_complete'
            and manifest['packageCount'] == len(manifest['packages']) == 104,
            'manifest_invalid')
    names = set()
    packages = set()
    for item in manifest['packages']:
        require(bool(re.fullmatch(r'[A-Za-z0-9_.-]+\.tar\.gz', item['file'])), 'package_name_invalid')
        name = 'src/contrib/' + item['file']
        require(name not in names and item['package'] not in packages, 'package_duplicate')
        names.add(name)
        packages.add(item['package'])
        raw = files.get(name)
        require(isinstance(raw, bytes) and len(raw) == item['bytes']
                and 'sha256:' + hashlib.sha256(raw).hexdigest() == item['sha256'],
                'package_hash_mismatch')
    require(names | {'manifest.json', 'PACKAGES.tsv', 'SHA256SUMS'} == set(files),
            'package_inventory_mismatch')


def safe_parents(root: Path, selected: Path) -> None:
    require(root.is_absolute() and root.resolve() == root, 'workspace_not_canonical')
    relative = selected.relative_to(root)
    current = root
    for component in relative.parts:
        current /= component
        info = current.lstat()
        require(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode), 'parent_unsafe')


def verify_existing(target: Path, files: dict[str, bytes]) -> None:
    found = set()
    directories = {'src', 'src/contrib'}
    pending = [target]
    while pending:
        directory = pending.pop()
        for selected in directory.iterdir():
            relative = selected.relative_to(target).as_posix()
            info = selected.lstat()
            if stat.S_ISDIR(info.st_mode):
                require(relative in directories and stat.S_IMODE(info.st_mode) == 0o755, 'directory_drift')
                pending.append(selected)
            else:
                require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1
                        and stat.S_IMODE(info.st_mode) == 0o644, 'file_unsafe')
                require(relative in files and info.st_size == len(files[relative]), 'file_inventory_drift')
                require(selected.read_bytes() == files[relative], 'file_content_drift')
                found.add(relative)
    require(found == set(files), 'file_inventory_drift')


def publish(root: Path, files: dict[str, bytes]) -> str:
    require(0 < len(files) <= 107 and all(isinstance(raw, bytes)
            and len(raw) <= MAX_FILE and bool(re.fullmatch(r'[A-Za-z0-9_.\-/]+', name))
            and all(part not in ('', '.', '..') for part in name.split('/'))
            for name, raw in files.items())
            and sum(map(len, files.values())) <= MAX_TOTAL, 'publication_input_invalid')
    target = root / TARGET
    safe_parents(root, target.parent)
    if target.exists() or target.is_symlink():
        require(stat.S_ISDIR(target.lstat().st_mode) and not target.is_symlink(), 'target_unsafe')
        if any(target.iterdir()):
            verify_existing(target, files)
            return 'existing_public_source_verified'
    stage = Path(tempfile.mkdtemp(prefix='.r-source-stage-', dir=target.parent))
    try:
        for name, raw in files.items():
            selected = stage / name
            selected.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
            with selected.open('xb') as stream:
                stream.write(raw)
            selected.chmod(0o644)
        for directory in (stage, stage / 'src', stage / 'src/contrib'):
            directory.chmod(0o755)
        verify_existing(stage, files)
        safe_parents(root, target.parent)
        # Renaming over a nonempty directory fails. Never recursively delete a
        # candidate's existing checkout or replace an invalid materialization.
        require(not target.is_symlink(), 'target_unsafe')
        os.replace(stage, target)
        verify_existing(target, files)
    finally:
        if stage.exists():
            shutil.rmtree(stage)
    return 'public_source_materialized'


def main() -> None:
    argparse.ArgumentParser(description=__doc__).parse_args()
    files = capture(ROOT)
    status = publish(ROOT, files)
    print(json.dumps({'kind': 'PublicRSourceCasMaterialization', 'status': status,
        'sourceTree': PUBLIC_TREE, 'fileCount': len(files), 'packageCount': 104,
        'gitlinkCommitVerified': False, 'productionAuthorized': False,
        'qualificationClaimed': False}, sort_keys=True))


if __name__ == '__main__':
    main()
