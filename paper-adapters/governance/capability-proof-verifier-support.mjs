import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { defaultPaperAssetRoot } from '../runtime/workspace-layout.mjs';

const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
const PAPER_ID_RE = /^[A-Za-z0-9_.-]+$/;
const PRODUCTION_SUBJECT_KEYS = Object.freeze(['paperId', 'sourceHash', 'sourcePath']);

function hasExactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
}

function sameFileIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function assertPathIdentitySnapshot(snapshot, errorCode) {
  for (const entry of snapshot) {
    const current = fs.lstatSync(entry.path, { bigint: true });
    if (!sameFileIdentity(current, entry.stat)
      || current.isSymbolicLink()
      || current.isDirectory() !== entry.stat.isDirectory()
      || current.isFile() !== entry.stat.isFile()) {
      throw new Error(errorCode);
    }
  }
}

export function capabilityProductionSubject(value, { exact = true } = {}) {
  if ((exact && !hasExactKeys(value, PRODUCTION_SUBJECT_KEYS))
    || typeof value?.paperId !== 'string'
    || !PAPER_ID_RE.test(value.paperId)
    || typeof value?.sourcePath !== 'string'
    || !value.sourcePath
    || value.sourcePath.includes('\\')
    || path.posix.isAbsolute(value.sourcePath)
    || path.posix.normalize(value.sourcePath) !== value.sourcePath
    || !SHA256_RE.test(String(value?.sourceHash || ''))) {
    throw new Error('capability_production_subject_invalid');
  }
  return Object.freeze(Object.fromEntries(
    PRODUCTION_SUBJECT_KEYS.map((key) => [key, value[key]]),
  ));
}

function stableRegularFileHash(file, pathSnapshot, maximumAttempts = 3) {
  const expectedFileIdentity = pathSnapshot.at(-1)?.stat;
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    let descriptor;
    try {
      assertPathIdentitySnapshot(
        pathSnapshot,
        'capability_production_source_path_changed',
      );
      descriptor = fs.openSync(
        file,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
      );
      const before = fs.fstatSync(descriptor, { bigint: true });
      if (!before.isFile()
        || !sameFileIdentity(before, expectedFileIdentity)
        || before.size < 1n
        || before.size > 128n * 1024n * 1024n) {
        throw new Error('capability_production_source_not_regular');
      }
      const bytes = fs.readFileSync(descriptor);
      const after = fs.fstatSync(descriptor, { bigint: true });
      assertPathIdentitySnapshot(
        pathSnapshot,
        'capability_production_source_path_changed',
      );
      if (before.dev === after.dev
        && before.ino === after.ino
        && before.size === after.size
        && before.mtimeNs === after.mtimeNs
        && before.ctimeNs === after.ctimeNs
        && BigInt(bytes.length) === before.size) {
        return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
      }
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }
  throw new Error('capability_production_source_unstable');
}

export function resolveCurrentCapabilityProductionSubject({
  assetRoot = defaultPaperAssetRoot(),
  paperId = 'A_Theory_of__Expectations',
} = {}) {
  if (typeof paperId !== 'string' || !PAPER_ID_RE.test(paperId)) {
    throw new Error('capability_production_paper_id_invalid');
  }
  const selectedAssetRoot = fs.realpathSync(path.resolve(assetRoot));
  const sourcePath = path.posix.join('submission', 'AoM', paperId, 'main.tex');
  const segments = sourcePath.split('/');
  let cursor = selectedAssetRoot;
  const pathSnapshot = [{
    path: cursor,
    stat: fs.lstatSync(cursor, { bigint: true }),
  }];
  if (!pathSnapshot[0].stat.isDirectory() || pathSnapshot[0].stat.isSymbolicLink()) {
    throw new Error('capability_production_asset_root_invalid');
  }
  for (let index = 0; index < segments.length; index += 1) {
    cursor = path.join(cursor, segments[index]);
    const stat = fs.lstatSync(cursor, { bigint: true });
    if (stat.isSymbolicLink()) throw new Error('capability_production_source_symlink_forbidden');
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new Error('capability_production_source_parent_invalid');
    }
    if (index === segments.length - 1 && !stat.isFile()) {
      throw new Error('capability_production_source_not_regular');
    }
    pathSnapshot.push({ path: cursor, stat });
  }
  const sourceFile = cursor;
  const resolvedSourceFile = fs.realpathSync(sourceFile);
  const relative = path.relative(selectedAssetRoot, resolvedSourceFile);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('capability_production_source_outside_asset_root');
  }
  return capabilityProductionSubject({
    paperId,
    sourcePath,
    sourceHash: stableRegularFileHash(sourceFile, pathSnapshot),
  });
}

export function readBoundRegularJson(root, candidate) {
  const selectedRoot = path.resolve(root);
  const selected = path.resolve(candidate);
  const relative = path.relative(selectedRoot, selected);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('capability_proof_path_outside_runtime_root');
  }
  let cursor = selectedRoot;
  const rootStat = fs.lstatSync(cursor, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('capability_proof_runtime_root_invalid');
  }
  const pathSnapshot = [{ path: cursor, stat: rootStat }];
  const segments = relative.split(path.sep);
  for (let index = 0; index < segments.length; index += 1) {
    cursor = path.join(cursor, segments[index]);
    const stat = fs.lstatSync(cursor, { bigint: true });
    if (stat.isSymbolicLink()) throw new Error('capability_proof_symlink_forbidden');
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new Error('capability_proof_parent_not_directory');
    }
    if (index === segments.length - 1 && !stat.isFile()) {
      throw new Error('capability_proof_not_regular_file');
    }
    pathSnapshot.push({ path: cursor, stat });
  }
  const selectedIdentity = pathSnapshot.at(-1).stat;
  let descriptor;
  try {
    descriptor = fs.openSync(
      selected,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile()
      || !sameFileIdentity(before, selectedIdentity)
      || before.size < 1n
      || before.size > 16n * 1024n * 1024n) {
      throw new Error('capability_proof_file_size_invalid');
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    assertPathIdentitySnapshot(pathSnapshot, 'capability_proof_path_changed_during_read');
    if (!sameFileIdentity(before, after)
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
      || BigInt(bytes.length) !== before.size) {
      throw new Error('capability_proof_file_changed_during_read');
    }
    return JSON.parse(bytes.toString('utf8'));
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function resolveConformanceArtifact(runtimeRoot, logicalPath) {
  if (typeof logicalPath !== 'string'
    || !logicalPath
    || logicalPath.includes('\\')
    || path.posix.isAbsolute(logicalPath)
    || path.posix.normalize(logicalPath) !== logicalPath
    || !logicalPath.startsWith('conformance-proof/')) {
    throw new Error('conformance_artifact_logical_path_invalid');
  }
  return path.join(path.resolve(runtimeRoot), ...logicalPath.split('/'));
}
