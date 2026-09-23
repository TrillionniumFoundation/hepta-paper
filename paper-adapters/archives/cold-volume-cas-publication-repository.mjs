import crypto from 'node:crypto';
import fs from 'node:fs';

import {
  assertPinnedCasDirectoryChain,
  assertPinnedCasFileCurrent,
  assertPinnedCasPublishedFile,
  errorCausedByCode,
  hashPinnedCasFile,
  openPinnedCasRegularFile,
  pinnedCasChildPath,
} from './cold-volume-cas-path-boundary.mjs';

const NO_FOLLOW = fs.constants.O_NOFOLLOW;
const SOURCE_COPY_BUFFER_BYTES = 8 * 1024 * 1024;

function boundaryError(errorCode, cause) {
  if (cause?.message === errorCode) return cause;
  return new Error(errorCode, { cause });
}

function sameIdentity(left, right) {
  return Boolean(left && right
    && ['dev', 'ino', 'uid', 'gid'].every((key) => left[key] === right[key]));
}

function openPublishedFile(directoryChain, name, expectedFileHash, errorCode) {
  const pinned = openPinnedCasRegularFile(null, errorCode, { directoryChain, name });
  try {
    assertPinnedCasPublishedFile(pinned, errorCode);
    if (expectedFileHash !== null
      && hashPinnedCasFile(pinned, errorCode) !== expectedFileHash) throw new Error(errorCode);
    return Object.freeze({ identity: pinned.identity, pinned });
  } catch (error) {
    fs.closeSync(pinned.descriptor);
    throw boundaryError(errorCode, error);
  }
}

function closePinnedFile(pinned) {
  if (pinned?.descriptor === undefined) return;
  try { fs.closeSync(pinned.descriptor); } catch { /* Already closed. */ }
}

function removeExactEntry(descriptorPath, expectedIdentity) {
  try {
    const selected = fs.lstatSync(descriptorPath, { bigint: true });
    const identity = Object.freeze({
      dev: String(selected.dev), gid: String(selected.gid), ino: String(selected.ino),
      uid: String(selected.uid),
    });
    if (selected.isFile() && !selected.isSymbolicLink()
      && sameIdentity(identity, expectedIdentity)) fs.unlinkSync(descriptorPath);
  } catch { /* Never remove a path whose exact identity is no longer known. */ }
}

function writeDescriptorFully(descriptor, bytes, fileOffset = 0) {
  let bytesOffset = 0;
  while (bytesOffset < bytes.length) {
    const written = fs.writeSync(
      descriptor,
      bytes,
      bytesOffset,
      bytes.length - bytesOffset,
      fileOffset + bytesOffset,
    );
    if (written <= 0) throw new Error('cold_volume_cas_staging_write_incomplete');
    bytesOffset += written;
  }
}

function streamPinnedSourceToDescriptor(source, descriptor, expectedFileHash, errorCode) {
  const expectedSize = BigInt(source.identity.size);
  if (expectedSize > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(errorCode);
  const buffer = Buffer.allocUnsafe(SOURCE_COPY_BUFFER_BYTES);
  const hash = crypto.createHash('sha256');
  let offset = 0;
  while (BigInt(offset) < expectedSize) {
    const remaining = expectedSize - BigInt(offset);
    const requested = Number(remaining > BigInt(buffer.length)
      ? BigInt(buffer.length)
      : remaining);
    const bytesRead = fs.readSync(source.descriptor, buffer, 0, requested, offset);
    if (bytesRead <= 0) throw new Error(errorCode);
    const selected = buffer.subarray(0, bytesRead);
    hash.update(selected);
    writeDescriptorFully(descriptor, selected, offset);
    offset += bytesRead;
  }
  assertPinnedCasFileCurrent(source, errorCode);
  if (BigInt(offset) !== expectedSize
    || `sha256:${hash.digest('hex')}` !== expectedFileHash) throw new Error(errorCode);
}

function stagePinnedFile(directoryChain, bytes, expectedFileHash, errorCode) {
  assertPinnedCasDirectoryChain(directoryChain, errorCode);
  const name = `.cold-cas-${process.pid}-${crypto.randomBytes(16).toString('hex')}.staging`;
  const descriptorPath = pinnedCasChildPath(directoryChain.at(-1), name, errorCode);
  let descriptor;
  try {
    descriptor = fs.openSync(
      descriptorPath,
      fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    writeDescriptorFully(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.fchmodSync(descriptor, 0o444);
    fs.fsyncSync(descriptor);
    const pinned = openPinnedCasRegularFile(null, errorCode, { directoryChain, name });
    try {
      assertPinnedCasPublishedFile(pinned, errorCode);
      if (hashPinnedCasFile(pinned, errorCode) !== expectedFileHash) throw new Error(errorCode);
      return Object.freeze({
        cleanupDirectory: directoryChain.at(-1), descriptorPath, identity: pinned.identity, name,
      });
    } finally { fs.closeSync(pinned.descriptor); }
  } catch (error) {
    if (descriptor !== undefined) {
      const stat = fs.fstatSync(descriptor, { bigint: true });
      removeExactEntry(descriptorPath, Object.freeze({
        dev: String(stat.dev), gid: String(stat.gid), ino: String(stat.ino), uid: String(stat.uid),
      }));
    }
    throw boundaryError(errorCode, error);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function stagePinnedSourceFile(directoryChain, source, expectedFileHash, errorCode) {
  assertPinnedCasDirectoryChain(directoryChain, errorCode);
  const name = `.cold-cas-${process.pid}-${crypto.randomBytes(16).toString('hex')}.staging`;
  const descriptorPath = pinnedCasChildPath(directoryChain.at(-1), name, errorCode);
  let descriptor;
  try {
    descriptor = fs.openSync(
      descriptorPath,
      fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    streamPinnedSourceToDescriptor(source, descriptor, expectedFileHash, errorCode);
    fs.fsyncSync(descriptor);
    fs.fchmodSync(descriptor, 0o444);
    fs.fsyncSync(descriptor);
    const pinned = openPinnedCasRegularFile(null, errorCode, { directoryChain, name });
    try {
      assertPinnedCasPublishedFile(pinned, errorCode);
      if (pinned.identity.size !== source.identity.size
        || hashPinnedCasFile(pinned, errorCode) !== expectedFileHash) throw new Error(errorCode);
      return Object.freeze({
        cleanupDirectory: directoryChain.at(-1), descriptorPath, identity: pinned.identity, name,
      });
    } finally { fs.closeSync(pinned.descriptor); }
  } catch (error) {
    if (descriptor !== undefined) {
      const stat = fs.fstatSync(descriptor, { bigint: true });
      removeExactEntry(descriptorPath, Object.freeze({
        dev: String(stat.dev), gid: String(stat.gid), ino: String(stat.ino), uid: String(stat.uid),
      }));
    }
    throw boundaryError(errorCode, error);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function publishStagedNoClobber(directoryChain, name, staged, expectedFileHash, errorCode) {
  const targetPath = pinnedCasChildPath(directoryChain.at(-1), name, errorCode);
  let linked = false;
  const cleanupDirectory = staged.cleanupDirectory || directoryChain.at(-1);
  const removeStaged = () => {
    removeExactEntry(staged.descriptorPath, staged.identity);
    fs.fsyncSync(cleanupDirectory.descriptor);
  };
  try {
    try {
      fs.linkSync(staged.descriptorPath, targetPath);
      linked = true;
      fs.fsyncSync(directoryChain.at(-1).descriptor);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = openPublishedFile(directoryChain, name, expectedFileHash, errorCode);
      closePinnedFile(existing.pinned);
      return existing.identity;
    }
    removeStaged();
    const published = openPublishedFile(directoryChain, name, expectedFileHash, errorCode);
    closePinnedFile(published.pinned);
    return published.identity;
  } finally {
    if (!linked) removeStaged();
  }
}

function publishPinnedBytes(directoryChain, name, bytes, expectedFileHash, errorCode) {
  try {
    const existing = openPublishedFile(directoryChain, name, expectedFileHash, errorCode);
    closePinnedFile(existing.pinned);
    return existing.identity;
  } catch (error) {
    if (!errorCausedByCode(error, 'ENOENT')) throw error;
  }
  const staged = stagePinnedFile(directoryChain, bytes, expectedFileHash, errorCode);
  return publishStagedNoClobber(
    directoryChain, name, staged, expectedFileHash, errorCode,
  );
}

export function publishPinnedCasSourceFile(
  directoryChain,
  name,
  sourcePath,
  expectedFileHash,
  errorCode,
  {
    consumeSource = false,
    sourceDirectoryChain = null,
    sourceName = null,
  } = {},
) {
  const source = openPinnedCasRegularFile(sourcePath, errorCode, sourceDirectoryChain
    ? { directoryChain: sourceDirectoryChain, name: sourceName }
    : {});
  try {
    if (consumeSource) {
      assertPinnedCasPublishedFile(source, errorCode);
      if (source.identity.dev !== directoryChain.at(-1).identity.dev
        || hashPinnedCasFile(source, errorCode) !== expectedFileHash) throw new Error(errorCode);
      return publishStagedNoClobber(directoryChain, name, Object.freeze({
        cleanupDirectory: source.directoryChain.at(-1),
        descriptorPath: source.descriptorPath,
        identity: source.identity,
        name: sourceName,
      }), expectedFileHash, errorCode);
    }
    try {
      const existing = openPublishedFile(directoryChain, name, expectedFileHash, errorCode);
      closePinnedFile(existing.pinned);
      if (hashPinnedCasFile(source, errorCode) !== expectedFileHash) throw new Error(errorCode);
      return existing.identity;
    } catch (error) {
      if (!errorCausedByCode(error, 'ENOENT')) throw error;
    }
    const staged = stagePinnedSourceFile(
      directoryChain, source, expectedFileHash, errorCode,
    );
    return publishStagedNoClobber(
      directoryChain, name, staged, expectedFileHash, errorCode,
    );
  } finally { fs.closeSync(source.descriptor); }
}

export function publishPinnedCasBytes(directoryChain, name, bytes, errorCode) {
  const expectedFileHash = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
  return publishPinnedBytes(directoryChain, name, bytes, expectedFileHash, errorCode);
}

export function replacePinnedCasBytes(directoryChain, name, bytes, errorCode) {
  const expectedFileHash = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
  const staged = stagePinnedFile(directoryChain, bytes, expectedFileHash, errorCode);
  const targetPath = pinnedCasChildPath(directoryChain.at(-1), name, errorCode);
  let previous;
  let committed = false;
  try {
    try { previous = openPublishedFile(directoryChain, name, null, errorCode); }
    catch (error) { if (!errorCausedByCode(error, 'ENOENT')) throw error; }
    if (previous) {
      assertPinnedCasPublishedFile(previous.pinned, errorCode);
      fs.renameSync(staged.descriptorPath, targetPath);
      committed = true;
    } else {
      fs.linkSync(staged.descriptorPath, targetPath);
      committed = true;
      removeExactEntry(staged.descriptorPath, staged.identity);
    }
    fs.fsyncSync(directoryChain.at(-1).descriptor);
    const installed = openPublishedFile(directoryChain, name, expectedFileHash, errorCode);
    closePinnedFile(installed.pinned);
    return installed.identity;
  } catch (error) {
    throw boundaryError(errorCode, error);
  } finally {
    closePinnedFile(previous?.pinned);
    if (!committed) removeExactEntry(staged.descriptorPath, staged.identity);
  }
}
