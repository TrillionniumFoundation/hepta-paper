import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const STABLE_FIELDS = ['dev', 'ino', 'size', 'nlink', 'mode', 'mtimeNs', 'ctimeNs'];
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const captures = new WeakMap();

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function parentIdentities(file) {
  const parents = [];
  for (let selected = path.dirname(file); ; selected = path.dirname(selected)) {
    const stat = fs.lstatSync(selected, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('legacy_matrix_parent_unsafe');
    parents.push({ path: selected, dev: stat.dev, ino: stat.ino });
    if (selected === path.dirname(selected)) return parents;
  }
}

export function readStableLegacyFile(file, maximumBytes = MAX_ARCHIVE_BYTES) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.resolve(file) !== file
    || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    fail('legacy_matrix_file_path_or_limit_invalid');
  }
  const parents = parentIdentities(file);
  const selected = fs.lstatSync(file, { bigint: true });
  if (!selected.isFile() || selected.isSymbolicLink() || selected.nlink !== 1n
    || selected.size > BigInt(maximumBytes)) fail('legacy_matrix_file_unsafe');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!STABLE_FIELDS.every((key) => selected[key] === before[key])) {
      fail('legacy_matrix_file_changed');
    }
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (read < 1) fail('legacy_matrix_file_short_read');
      offset += read;
    }
    if (fs.readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0) fail('legacy_matrix_file_changed');
    const after = fs.fstatSync(fd, { bigint: true });
    const current = fs.lstatSync(file, { bigint: true });
    if (!STABLE_FIELDS.every((key) => before[key] === after[key] && before[key] === current[key])) {
      fail('legacy_matrix_file_changed');
    }
    for (const parent of parents) {
      const stat = fs.lstatSync(parent.path, { bigint: true });
      if (!stat.isDirectory() || stat.dev !== parent.dev || stat.ino !== parent.ino) {
        fail('legacy_matrix_parent_changed');
      }
    }
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

export function legacyBytesHash(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

export function captureLegacyMatrixArchive(file, expectedSha256) {
  if (typeof expectedSha256 !== 'string' || !SHA256.test(expectedSha256)) fail('legacy_matrix_archive_digest_invalid');
  const bytes = readStableLegacyFile(file);
  if (legacyBytesHash(bytes) !== expectedSha256) fail('legacy_matrix_archive_hash_mismatch');
  const capture = Object.freeze({ archivePath: file, archiveSha256: expectedSha256, bytes: bytes.length });
  // The extraction input is private, not a caller-mutable Buffer or a reopened path.
  captures.set(capture, bytes);
  return capture;
}

function runTar(bytes, args) {
  const result = spawnSync('/usr/bin/tar', args, {
    input: bytes,
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    shell: false,
    timeout: 30000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.status !== 0 || result.signal) fail('legacy_matrix_tar_failed');
  return result.stdout;
}

export function extractLegacyMatrixSources(capture, sources, root) {
  const bytes = captures.get(capture);
  if (!bytes) fail('legacy_matrix_archive_capture_required');
  if (!Array.isArray(sources) || !sources.length || sources.length > 4096) {
    fail('legacy_matrix_sources_invalid');
  }
  const unique = new Set();
  for (const source of sources) {
    if (typeof source?.path !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/u.test(source.path)
      || source.path.split('/').some((part) => !part || part === '.' || part === '..')
      || !SHA256.test(source.sha256) || unique.has(source.path)) {
      fail('legacy_matrix_source_invalid');
    }
    unique.add(source.path);
  }
  if (typeof root !== 'string' || !path.isAbsolute(root) || path.resolve(root) !== root) {
    fail('legacy_matrix_destination_unsafe');
  }
  const rootStat = fs.lstatSync(root, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || fs.readdirSync(root).length) {
    fail('legacy_matrix_destination_unsafe');
  }
  parentIdentities(path.join(root, 'member'));
  const names = runTar(bytes, ['--list', '--gzip', '--file', '-', '--quoting-style=escape'])
    .split('\n').filter(Boolean).map((name) => name.replace(/\/$/u, ''));
  const verbose = runTar(bytes, ['--list', '--verbose', '--numeric-owner', '--gzip', '--file', '-', '--quoting-style=escape'])
    .split('\n').filter(Boolean);
  const types = new Map();
  const counts = new Map();
  const sizes = new Map();
  if (verbose.length !== names.length) fail('legacy_matrix_archive_inventory_invalid');
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];
    counts.set(name, (counts.get(name) || 0) + 1);
    types.set(name, verbose[index]?.[0]);
    const size = verbose[index].match(/^.\S*\s+[0-9]+\/[0-9]+\s+([0-9]+)\s/u)?.[1];
    sizes.set(name, size === undefined ? null : BigInt(size));
  }
  let selectedBytes = 0n;
  for (const source of sources) {
    if (counts.get(source.path) !== 1 || types.get(source.path) !== '-') {
      fail('legacy_matrix_source_not_unique_regular');
    }
    const size = sizes.get(source.path);
    if (size === null || size === undefined || size > BigInt(MAX_ARCHIVE_BYTES)) {
      fail('legacy_matrix_source_size_invalid');
    }
    selectedBytes += size;
    if (selectedBytes > BigInt(MAX_ARCHIVE_BYTES)) fail('legacy_matrix_extraction_byte_limit');
    const parts = source.path.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      const parent = parts.slice(0, index).join('/');
      if (counts.has(parent) && (counts.get(parent) !== 1 || types.get(parent) !== 'd')) {
        fail('legacy_matrix_archive_parent_unsafe');
      }
    }
  }
  runTar(bytes, ['--extract', '--gzip', '--file', '-', '--directory', root,
    '--no-same-owner', '--no-same-permissions', '--keep-old-files', '--', ...unique]);
  const after = fs.lstatSync(root, { bigint: true });
  if (!after.isDirectory() || after.dev !== rootStat.dev || after.ino !== rootStat.ino) {
    fail('legacy_matrix_destination_changed');
  }
  for (const source of sources) {
    const file = path.join(root, source.path);
    if (legacyBytesHash(readStableLegacyFile(file)) !== source.sha256) {
      fail('legacy_matrix_source_hash_mismatch');
    }
  }
  return sources.length;
}
