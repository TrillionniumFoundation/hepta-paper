import fs from 'node:fs';
import path from 'node:path';

import { hashBytes } from '../../workflow-kernel/record-hash.mjs';

const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;
const MAXIMUM_ARTIFACT_BYTES = 8 * 1024 * 1024;

function codedError(code, details = {}) {
  return Object.assign(new Error(code), { code, ...details });
}

export function immutableReleasePathWithinOrSame(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative));
}

export function regularFileSnapshot(file, {
  includeContent,
  maximumContentBase64Bytes = null,
} = {}) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | NO_FOLLOW);
    const before = fs.fstatSync(descriptor, { bigint: true });
    const atPath = fs.lstatSync(file, { bigint: true });
    if (!before.isFile() || atPath.isSymbolicLink() || !atPath.isFile()
      || before.dev !== atPath.dev || before.ino !== atPath.ino || before.nlink !== 1n
      || before.size < 0n || before.size > BigInt(MAXIMUM_ARTIFACT_BYTES)) {
      throw codedError('immutable_release_host_artifact_invalid');
    }
    if (includeContent && maximumContentBase64Bytes !== null) {
      const encodedBytes = 4 * Math.ceil(Number(before.size) / 3);
      if (!Number.isSafeInteger(maximumContentBase64Bytes)
        || maximumContentBase64Bytes < 0 || encodedBytes > maximumContentBase64Bytes) {
        throw codedError('immutable_release_host_snapshot_budget_exceeded');
      }
    }
    const content = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || BigInt(content.length) !== before.size) {
      throw codedError('immutable_release_host_artifact_changed');
    }
    const material = Object.freeze({
      contentHash: hashBytes(content),
      uid: Number(before.uid),
      gid: Number(before.gid),
      mode: Number(before.mode) & 0o7777,
    });
    return includeContent
      ? Object.freeze({ ...material, contentBase64: content.toString('base64') })
      : material;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function existsNoFollow(candidate) {
  try { fs.lstatSync(candidate); return true; } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

export function assertSafeArtifactParent(file, { expectedUid, expectedGid, boundary = '/' }) {
  const parent = path.dirname(file);
  if (!path.isAbsolute(file) || !immutableReleasePathWithinOrSame(boundary, file)) {
    throw codedError('immutable_release_host_artifact_path_invalid');
  }
  const stat = fs.lstatSync(parent, { bigint: true });
  if (fs.realpathSync(parent) !== parent || stat.isSymbolicLink() || !stat.isDirectory()
    || Number(stat.uid) !== expectedUid || Number(stat.gid) !== expectedGid
    || (Number(stat.mode) & 0o022) !== 0) {
    throw codedError('immutable_release_host_artifact_parent_invalid');
  }
  return parent;
}

export function writeArtifactAtomically(
  file,
  content,
  { uid, gid, mode, expectedUid, expectedGid, boundary },
) {
  const parent = assertSafeArtifactParent(file, { expectedUid, expectedGid, boundary });
  if (existsNoFollow(file)) {
    const current = fs.lstatSync(file, { bigint: true });
    if (current.isSymbolicLink() || !current.isFile() || current.nlink !== 1n) {
      throw codedError('immutable_release_host_artifact_destination_invalid');
    }
  }
  const temporary = path.join(parent, `.hepta-deploy.${process.pid}.${Date.now()}`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW, 0o600);
    fs.fchownSync(descriptor, uid, gid);
    fs.fchmodSync(descriptor, mode);
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
    fsyncDirectory(parent);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
}
