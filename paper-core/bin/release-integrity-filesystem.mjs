import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_MAXIMUM_BYTES = 2 * 1024 * 1024;

function sha256Bytes(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function pathWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate)).replace(/\\/g, '/');
  return relative && relative !== '..' && !relative.startsWith('../')
    && !path.posix.isAbsolute(relative) ? relative : null;
}

function snapshotDirectoryChain(directory, fileSystem = fs) {
  const absolute = path.resolve(directory);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  const rootStat = fileSystem.lstatSync(current);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('release_integrity_directory_chain_unsafe');
  }
  const snapshots = [{ path: current, dev: rootStat.dev, ino: rootStat.ino }];
  for (const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = fileSystem.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('release_integrity_directory_chain_unsafe');
    }
    snapshots.push({ path: current, dev: stat.dev, ino: stat.ino });
  }
  return Object.freeze(snapshots.map((entry) => Object.freeze(entry)));
}

function assertDirectoryChainUnchanged(snapshot, fileSystem = fs) {
  for (const expected of snapshot) {
    const actual = fileSystem.lstatSync(expected.path);
    if (!actual.isDirectory() || actual.isSymbolicLink()
      || actual.dev !== expected.dev || actual.ino !== expected.ino) {
      throw new Error('release_integrity_directory_chain_changed');
    }
  }
}

export function readReleaseIntegrityRegularFile(file, {
  maximumBytes = DEFAULT_MAXIMUM_BYTES,
  fileSystem = fs,
  beforeOpen = () => {},
} = {}) {
  const parents = snapshotDirectoryChain(path.dirname(file), fileSystem);
  beforeOpen();
  let descriptor;
  try {
    descriptor = fileSystem.openSync(
      file,
      fileSystem.constants.O_RDONLY | (fileSystem.constants.O_NOFOLLOW || 0),
    );
    const before = fileSystem.fstatSync(descriptor);
    if (!before.isFile() || Number(before.nlink) !== 1) throw new Error('release_evidence_file_not_private_regular');
    if (before.size < 1 || before.size > maximumBytes) throw new Error('release_evidence_file_size_invalid');
    const selected = fileSystem.lstatSync(file);
    if (!selected.isFile() || selected.isSymbolicLink()
      || selected.dev !== before.dev || selected.ino !== before.ino) throw new Error('release_evidence_file_path_identity_mismatch');
    const bytes = fileSystem.readFileSync(descriptor);
    const after = fileSystem.fstatSync(descriptor);
    const finalPath = fileSystem.lstatSync(file);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || bytes.length !== before.size
      || finalPath.dev !== before.dev || finalPath.ino !== before.ino) {
      throw new Error('release_evidence_file_changed_during_read');
    }
    assertDirectoryChainUnchanged(parents, fileSystem);
    return bytes;
  } finally {
    if (descriptor !== undefined) fileSystem.closeSync(descriptor);
  }
}

export function hashReleaseIntegrityRegularFile(file, {
  fileSystem = fs,
  beforeOpen = () => {},
} = {}) {
  const parents = snapshotDirectoryChain(path.dirname(file), fileSystem);
  beforeOpen();
  let descriptor;
  try {
    descriptor = fileSystem.openSync(file, fileSystem.constants.O_RDONLY | (fileSystem.constants.O_NOFOLLOW || 0));
    const before = fileSystem.fstatSync(descriptor);
    if (!before.isFile() || Number(before.nlink) !== 1) throw new Error('release_evidence_file_not_private_regular');
    const selected = fileSystem.lstatSync(file);
    if (!selected.isFile() || selected.isSymbolicLink()
      || selected.dev !== before.dev || selected.ino !== before.ino) throw new Error('release_evidence_file_path_identity_mismatch');
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < before.size) {
      const read = fileSystem.readSync(descriptor, buffer, 0, Math.min(buffer.length, before.size - position), position);
      if (read < 1) throw new Error('release_evidence_file_short_read');
      hash.update(buffer.subarray(0, read));
      position += read;
    }
    const after = fileSystem.fstatSync(descriptor);
    const finalPath = fileSystem.lstatSync(file);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || finalPath.dev !== before.dev || finalPath.ino !== before.ino) throw new Error('release_evidence_file_changed_during_hash');
    assertDirectoryChainUnchanged(parents, fileSystem);
    return `sha256:${hash.digest('hex')}`;
  } finally {
    if (descriptor !== undefined) fileSystem.closeSync(descriptor);
  }
}

export function ensureReleaseIntegrityPrivateDirectory(runtimeRoot, candidate, {
  fileSystem = fs,
  beforeRevalidation = () => {},
} = {}) {
  const root = path.resolve(runtimeRoot);
  const destination = path.resolve(candidate);
  const relative = pathWithin(root, destination);
  const rootChain = snapshotDirectoryChain(root, fileSystem);
  if (!relative) throw new Error('release_evidence_output_directory_outside_runtime');
  const rootStat = fileSystem.lstatSync(root);
  const expectedOwnerUid = Number(rootStat.uid);
  const assertPrivateDirectory = (stat) => {
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || (stat.mode & 0o7777) !== 0o700
      || !Number.isSafeInteger(expectedOwnerUid)
      || Number(stat.uid) !== expectedOwnerUid) {
      throw new Error('release_evidence_output_directory_unsafe');
    }
  };
  let current = root;
  const selected = [];
  for (const component of relative.split('/')) {
    current = path.join(current, component);
    try {
      const stat = fileSystem.lstatSync(current);
      assertPrivateDirectory(stat);
      selected.push({
        path: current,
        dev: stat.dev,
        ino: stat.ino,
        mode: stat.mode & 0o7777,
        uid: Number(stat.uid),
      });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      fileSystem.mkdirSync(current, { mode: 0o700 });
      const created = fileSystem.lstatSync(current);
      assertPrivateDirectory(created);
      selected.push({
        path: current,
        dev: created.dev,
        ino: created.ino,
        mode: created.mode & 0o7777,
        uid: Number(created.uid),
      });
    }
  }
  beforeRevalidation();
  assertDirectoryChainUnchanged(rootChain, fileSystem);
  assertDirectoryChainUnchanged(selected, fileSystem);
  for (const expected of selected) {
    const actual = fileSystem.lstatSync(expected.path);
    assertPrivateDirectory(actual);
    if ((actual.mode & 0o7777) !== expected.mode || Number(actual.uid) !== expected.uid) {
      throw new Error('release_evidence_output_directory_changed');
    }
  }
  if (fileSystem.realpathSync(current) !== current) throw new Error('release_evidence_output_directory_unsafe');
  return current;
}

export const releaseIntegrityFilesystem = Object.freeze({
  assertDirectoryChainUnchanged,
  ensurePrivateDirectory: ensureReleaseIntegrityPrivateDirectory,
  hashRegularFile: hashReleaseIntegrityRegularFile,
  readRegularFile: readReleaseIntegrityRegularFile,
  snapshotDirectoryChain,
  sha256Bytes,
});
