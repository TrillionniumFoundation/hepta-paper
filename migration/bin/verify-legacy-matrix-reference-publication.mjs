#!/usr/bin/env node

/**
 * Verify the hash-bound 263-file legacy reference without trusting a live
 * legacy checkout.  The canonical archive is intentionally an opaque private
 * object; only the matrix-listed regular files are inspected.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_POINTER = path.join(moduleRoot, 'migration', 'fixtures',
  'legacy-matrix-reference-publication-v1.json');
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;

function fail(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  throw error;
}

function parseArgs(argv) {
  const result = {
    pointerPath: DEFAULT_POINTER,
    archivePath: process.env.HEPTA_LEGACY_REFERENCE_ARCHIVE || null,
    matrixPath: null,
    companionManifestPath: null,
    extractDir: null,
    metadataOnly: false,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      index += 1;
      if (index >= argv.length || argv[index].startsWith('-')) fail('argument_value_required', { argument });
      return argv[index];
    };
    if (argument === '--pointer') result.pointerPath = value();
    else if (argument === '--archive') result.archivePath = value();
    else if (argument === '--matrix') result.matrixPath = value();
    else if (argument === '--companion-manifest') result.companionManifestPath = value();
    else if (argument === '--extract-dir') result.extractDir = value();
    else if (argument === '--metadata-only') result.metadataOnly = true;
    else if (argument === '--json') result.json = true;
    else if (argument === '--help') {
      process.stdout.write([
        'Usage: verify-legacy-matrix-reference-publication [options]',
        '',
        '  --archive PATH             Exact private archive to hash and inspect.',
        '  --pointer PATH             Repository publication locator (default: canonical locator).',
      '  --matrix PATH              Override the matrix path (normally from the locator).',
      '  --companion-manifest PATH  Verify a downloaded private publication manifest.',
      '  --extract-dir PATH         Preserve a read-only 263-file sanitized extraction.',
        '  --metadata-only            Verify locator/manifest without an archive.',
        '  --json                     Emit the verification record as JSON.',
      ].join('\n') + '\n');
      return null;
    } else fail('unknown_argument', { argument });
  }
  return result;
}

function readJson(file, label) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`${label}_json_invalid`, { message: error.message });
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label}_object_required`);
  }
  return value;
}

function absoluteRegularFile(file, label) {
  if (typeof file !== 'string' || !path.isAbsolute(file)
    || path.resolve(file) !== file) fail(`${label}_absolute_path_required`);
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    fail(`${label}_not_found`, { message: error.message });
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label}_regular_file_required`);
  return file;
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    for (;;) {
      const read = fs.readSync(descriptor, buffer, 0, buffer.length, position);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
      position += read;
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return `sha256:${hash.digest('hex')}`;
}

function runTar(args, label, maxBuffer = 64 * 1024 * 1024) {
  const result = spawnSync('tar', args, {
    encoding: 'utf8',
    maxBuffer,
  });
  if (result.error || result.status !== 0) {
    fail(`${label}_failed`, {
      status: result.status,
      message: result.error?.message || String(result.stderr || '').trim(),
    });
  }
  return result.stdout;
}

function safeRelativeSourcePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0')
    || path.isAbsolute(value) || path.posix.normalize(value) !== value
    || value.split('/').some((part) => part === '..' || part === '')) {
    fail('matrix_source_path_unsafe', { path: value });
  }
  return value;
}

function safeRelativeRepositoryPath(value, label) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0')
    || path.posix.isAbsolute(value) || path.posix.normalize(value) !== value
    || value.split('/').some((part) => part === '..' || part === '')) {
    fail(`${label}_unsafe`, { path: value });
  }
  return value;
}

function normalizeSourceHash(value) {
  const text = String(value || '');
  const normalized = text.startsWith('sha256:') ? text.slice('sha256:'.length) : text;
  if (!HEX64.test(normalized)) fail('matrix_source_hash_invalid', { value });
  return `sha256:${normalized}`;
}

function loadMatrix(matrixPath, pointer) {
  absoluteRegularFile(matrixPath, 'matrix');
  if (sha256File(matrixPath) !== pointer.matrix.sha256) fail('matrix_hash_mismatch', {
    expected: pointer.matrix.sha256,
    actual: sha256File(matrixPath),
  });
  const matrix = readJson(matrixPath, 'matrix');
  if (!Array.isArray(matrix.entries)) fail('matrix_entries_required');
  if (matrix.entries.length !== pointer.matrix.sourceFileCount) fail('matrix_entry_count_mismatch', {
    expected: pointer.matrix.sourceFileCount,
    actual: matrix.entries.length,
  });
  const entries = matrix.entries.map((entry, index) => {
    const source = entry?.source;
    if (!source || typeof source !== 'object') fail('matrix_source_required', { index });
    return Object.freeze({
      path: safeRelativeSourcePath(source.path),
      sha256: normalizeSourceHash(source.sha256),
    });
  });
  const unique = new Set(entries.map((entry) => entry.path));
  if (unique.size !== entries.length) fail('matrix_source_paths_not_unique');
  return Object.freeze(entries);
}

function validatePointer(pointer) {
  if (pointer.version !== 1 || pointer.kind !== 'LegacyMatrixReferencePublication') {
    fail('publication_pointer_kind_invalid');
  }
  if (!pointer.canonicalManifestPath || !pointer.canonicalArchiveBasename) {
    fail('publication_pointer_binding_missing');
  }
  safeRelativeRepositoryPath(pointer.canonicalManifestPath, 'canonical_manifest_path');
  safeRelativeRepositoryPath(pointer.matrix?.path, 'matrix_path');
  if (path.basename(pointer.canonicalArchiveBasename) !== pointer.canonicalArchiveBasename
    || pointer.canonicalArchiveBasename.includes('\0')
    || pointer.canonicalArchiveBasename.includes('\\')) {
    fail('canonical_archive_basename_invalid');
  }
  if (!SHA256.test(pointer.canonicalArchiveSha256)
    || !SHA256.test(pointer.matrix?.sha256)
    || !Number.isSafeInteger(pointer.matrix?.sourceFileCount)
    || pointer.matrix.sourceFileCount < 1) {
    fail('publication_pointer_digest_or_count_invalid');
  }
  if (pointer.custody?.visibility !== 'private'
    || typeof pointer.custody?.repository !== 'string'
    || typeof pointer.custody?.commit !== 'string'
    || typeof pointer.custody?.tag !== 'string'
    || typeof pointer.custody?.releaseTag !== 'string'
    || !Number.isSafeInteger(pointer.custody?.archiveBytes)
    || pointer.custody.archiveBytes < 1
    || !Number.isSafeInteger(pointer.custody?.releaseAssetId)
    || pointer.custody.releaseAssetId < 1
    || !SHA256.test(pointer.custody?.releaseAssetDigest)
    || pointer.custody?.releaseAssetDigest !== pointer.canonicalArchiveSha256
    || pointer.custody?.releaseAssetBytes !== pointer.custody?.archiveBytes
    || pointer.custody?.releaseAssetState !== 'uploaded'
    || pointer.custody?.releasePlatformImmutable !== false) {
    fail('publication_pointer_custody_invalid');
  }
  return pointer;
}

function validateCompanionManifest(manifest, pointer) {
  if (manifest.version !== 1 || manifest.kind !== 'PublishedImmutableLegacyMatrixReference') {
    fail('companion_manifest_kind_invalid');
  }
  if (manifest.visibility !== 'private'
    || manifest.repository !== pointer.custody.repository
    || manifest.archive?.sha256 !== pointer.canonicalArchiveSha256
    || manifest.matrix?.sha256 !== pointer.matrix.sha256
    || manifest.matrix?.sourceFileCount !== pointer.matrix.sourceFileCount
    || manifest.matrix?.sourcePathsPresent !== pointer.matrix.sourceFileCount
    || manifest.matrix?.sourceHashesMatched !== pointer.matrix.sourceFileCount
    || manifest.matrix?.missing !== 0
    || manifest.matrix?.mismatches !== 0) {
    fail('companion_manifest_binding_mismatch');
  }
  if (manifest.archive?.bytes !== pointer.custody.archiveBytes
    || manifest.archive?.transport !== 'git-lfs') {
    fail('companion_manifest_archive_metadata_mismatch');
  }
  return manifest;
}

function archiveInventory(archivePath, sourcePaths) {
  const names = runTar(['-tzf', archivePath, '--quoting-style=literal'], 'archive_listing')
    .split('\n').filter(Boolean).map((name) => name.endsWith('/') ? name.slice(0, -1) : name);
  for (const name of names) {
    if (!name || name.includes('\0') || name.includes('\\') || path.posix.isAbsolute(name)
      || path.posix.normalize(name) !== name
      || name.split('/').some((part) => part === '..' || part === '')) {
      fail('archive_member_path_unsafe', { name });
    }
  }
  const nameCounts = new Map();
  for (const name of names) nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
  const verbose = runTar(['-tvzf', archivePath, '--quoting-style=literal'], 'archive_type_listing')
    .split('\n').filter(Boolean);
  const typeFor = (name) => {
    const candidates = verbose.filter((line) => line.endsWith(` ${name}`)
      || line.endsWith(` ${name}/`));
    if (candidates.length !== 1) fail('archive_member_binding_invalid', { name, matches: candidates.length });
    return candidates[0][0];
  };
  const counts = { regularFiles: 0, directories: 0, symlinks: 0, other: 0 };
  for (const line of verbose) {
    const type = line[0];
    if (type === '-') counts.regularFiles += 1;
    else if (type === 'd') counts.directories += 1;
    else if (type === 'l') counts.symlinks += 1;
    else counts.other += 1;
  }
  for (const sourcePath of sourcePaths) {
    if (nameCounts.get(sourcePath) !== 1 || typeFor(sourcePath) !== '-') {
      fail('archive_matrix_member_not_regular_unique', { path: sourcePath });
    }
    const parts = sourcePath.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      const parent = parts.slice(0, index).join('/');
      if (nameCounts.has(parent) && typeFor(parent) !== 'd') {
        fail('archive_matrix_parent_not_directory', { path: sourcePath, parent });
      }
    }
  }
  return Object.freeze({
    memberCount: names.length,
    ...counts,
  });
}

function makeReadOnlyTree(root) {
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) fail('prepared_tree_symlink_forbidden', { path: current });
    if (stat.isDirectory()) {
      fs.chmodSync(current, 0o555);
      for (const entry of fs.readdirSync(current)) pending.push(path.join(current, entry));
    } else if (stat.isFile()) fs.chmodSync(current, 0o444);
    else fail('prepared_tree_member_type_forbidden', { path: current });
  }
}

function makeWritableTree(root) {
  const pending = [root];
  const directories = [];
  while (pending.length) {
    const current = pending.pop();
    let stat;
    try { stat = fs.lstatSync(current); } catch { continue; }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      fs.chmodSync(current, 0o700);
      directories.push(current);
      for (const entry of fs.readdirSync(current)) pending.push(path.join(current, entry));
    } else if (stat.isFile()) fs.chmodSync(current, 0o600);
  }
  // Directory permissions are restored before recursive removal; process
  // children first so a read-only parent can never strand a child.
  for (const directory of directories.reverse()) fs.chmodSync(directory, 0o700);
}

function verifySourceHashes(archivePath, entries, requestedRoot = null) {
  if (requestedRoot !== null) {
    if (!path.isAbsolute(requestedRoot) || path.resolve(requestedRoot) !== requestedRoot) {
      fail('extract_dir_absolute_path_required');
    }
    if (fs.existsSync(requestedRoot)) fail('extract_dir_must_not_exist');
    fs.mkdirSync(requestedRoot, { recursive: false, mode: 0o700 });
  }
  const root = requestedRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-legacy-matrix-verify-'));
  const persistent = requestedRoot !== null;
  let completed = false;
  try {
    const paths = entries.map((entry) => entry.path);
    runTar([
      '--extract', '--gzip', '--file', archivePath,
      '--directory', root, '--no-same-owner', '--no-same-permissions', '--', ...paths,
    ], 'archive_matrix_extract');
    let matched = 0;
    for (const entry of entries) {
      const extracted = path.join(root, entry.path);
      absoluteRegularFile(extracted, 'extracted_matrix_member');
      const relativeParent = path.relative(root, extracted);
      let parent = root;
      for (const part of path.dirname(relativeParent).split(path.sep)) {
        if (!part || part === '.') continue;
        parent = path.join(parent, part);
        const parentStat = fs.lstatSync(parent);
        if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
          fail('prepared_tree_parent_not_directory', { path: parent });
        }
      }
      const actual = sha256File(extracted);
      if (actual !== entry.sha256) fail('archive_matrix_source_hash_mismatch', {
        path: entry.path, expected: entry.sha256, actual,
      });
      matched += 1;
    }
    makeReadOnlyTree(root);
    completed = true;
    return { matched, root: persistent ? root : null };
  } finally {
    if (!persistent || !completed) {
      makeWritableTree(root);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}

function verify(options) {
  const pointerPath = absoluteRegularFile(path.resolve(options.pointerPath), 'publication_pointer');
  const pointer = validatePointer(readJson(pointerPath, 'publication_pointer'));
  const canonicalManifestPath = path.resolve(moduleRoot, pointer.canonicalManifestPath);
  const canonicalManifest = readJson(canonicalManifestPath, 'canonical_manifest');
  if (canonicalManifest.archiveSha256 !== pointer.canonicalArchiveSha256
    || canonicalManifest.matrixSha256 !== pointer.matrix.sha256
    || canonicalManifest.sourceFileCount !== pointer.matrix.sourceFileCount) {
    fail('canonical_manifest_binding_mismatch');
  }
  if (options.companionManifestPath) {
    const companionPath = absoluteRegularFile(
      path.resolve(options.companionManifestPath), 'companion_manifest',
    );
    const companionHash = sha256File(companionPath);
    if (pointer.custody.publicationManifestSha256
      && companionHash !== pointer.custody.publicationManifestSha256) {
      fail('companion_manifest_hash_mismatch', {
        expected: pointer.custody.publicationManifestSha256,
        actual: companionHash,
      });
    }
    const companion = readJson(companionPath, 'companion_manifest');
    validateCompanionManifest(companion, pointer);
  }
  const matrixPath = path.resolve(options.matrixPath || path.join(moduleRoot, pointer.matrix.path));
  const entries = loadMatrix(matrixPath, pointer);
  const result = {
    version: 1,
    kind: 'LegacyMatrixReferencePublicationVerification',
    status: 'legacy_matrix_reference_publication_metadata_verified',
    pointerPath,
    matrixPath,
    matrixSha256: pointer.matrix.sha256,
    sourceFileCount: entries.length,
    companionRepository: pointer.custody.repository,
    companionCommit: pointer.custody.commit,
    companionTag: pointer.custody.tag,
    releaseTag: pointer.custody.releaseTag,
      releaseAssetId: pointer.custody.releaseAssetId,
      releaseAssetDigest: pointer.custody.releaseAssetDigest,
      releaseAssetBytes: pointer.custody.releaseAssetBytes,
      releaseId: pointer.custody.releaseId,
      archiveBytes: pointer.custody.archiveBytes,
  };
  if (options.metadataOnly) return Object.freeze(result);
  if (!options.archivePath) fail('archive_path_required');
  const archivePath = absoluteRegularFile(path.resolve(options.archivePath), 'archive');
  if (path.basename(archivePath) !== pointer.canonicalArchiveBasename) {
    fail('archive_basename_mismatch', {
      expected: pointer.canonicalArchiveBasename,
      actual: path.basename(archivePath),
    });
  }
  const archiveSha256 = sha256File(archivePath);
  if (archiveSha256 !== pointer.canonicalArchiveSha256) fail('archive_hash_mismatch', {
    expected: pointer.canonicalArchiveSha256, actual: archiveSha256,
  });
  const inventory = archiveInventory(archivePath, entries.map((entry) => entry.path));
  if (inventory.memberCount !== pointer.archiveInventory.memberCount
    || inventory.regularFiles !== pointer.archiveInventory.regularFiles
    || inventory.directories !== pointer.archiveInventory.directories
    || inventory.symlinks !== pointer.archiveInventory.symlinks) {
    fail('archive_inventory_mismatch', { expected: pointer.archiveInventory, actual: inventory });
  }
  const sourceVerification = verifySourceHashes(archivePath, entries, options.extractDir);
  return Object.freeze({
    ...result,
    status: 'legacy_matrix_reference_publication_verified',
    archivePath,
    archiveSha256,
    archiveBytes: fs.statSync(archivePath).size,
    archiveInventory: inventory,
    sourceHashesMatched: sourceVerification.matched,
    sourceHashesMissing: 0,
    sourceHashesMismatched: 0,
    ...(sourceVerification.root ? { preparedRoot: sourceVerification.root } : {}),
  });
}

const options = parseArgs(process.argv.slice(2));
if (options) {
  try {
    const result = verify(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const failure = {
      version: 1,
      kind: 'LegacyMatrixReferencePublicationVerification',
      status: 'legacy_matrix_reference_publication_blocked',
      code: error.code || 'verification_failed',
      ...(error.details ? { details: error.details } : {}),
    };
    const serialized = `${JSON.stringify(failure, null, 2)}\n`;
    if (options.json) process.stdout.write(serialized);
    else process.stderr.write(serialized);
    process.exitCode = 1;
  }
}
