import crypto from 'node:crypto';
import fs from 'node:fs';

import {
  assertPinnedCasDirectoryChain,
  assertPinnedCasPublishedFile,
  errorCausedByCode,
  hashPinnedCasFile,
  openPinnedCasRegularFile,
  pinnedCasChildPath,
} from './cold-volume-cas-path-boundary.mjs';

const NO_FOLLOW = fs.constants.O_NOFOLLOW;

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

function writeDescriptorFully(descriptor, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    offset += fs.writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
  }
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
      return Object.freeze({ descriptorPath, identity: pinned.identity, name });
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
    removeExactEntry(staged.descriptorPath, staged.identity);
    fs.fsyncSync(directoryChain.at(-1).descriptor);
    const published = openPublishedFile(directoryChain, name, expectedFileHash, errorCode);
    closePinnedFile(published.pinned);
    return published.identity;
  } finally {
    if (!linked) removeExactEntry(staged.descriptorPath, staged.identity);
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
) {
  const source = openPinnedCasRegularFile(sourcePath, errorCode);
  try {
    const bytes = fs.readFileSync(source.descriptor);
    if (String(bytes.length) !== source.identity.size
      || `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`
        !== expectedFileHash) throw new Error(errorCode);
    return publishPinnedBytes(directoryChain, name, bytes, expectedFileHash, errorCode);
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
