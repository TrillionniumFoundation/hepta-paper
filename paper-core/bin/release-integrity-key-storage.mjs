import crypto from 'node:crypto';
import path from 'node:path';

import { releaseIntegrityFilesystem } from './release-integrity-filesystem.mjs';

const {
  assertDirectoryChainUnchanged,
  snapshotDirectoryChain,
} = releaseIntegrityFilesystem;

const PRIVATE_NAME = 'release-integrity-ed25519-private.pem';
const PUBLIC_NAME = 'release-integrity-ed25519-public.pem';
const EXPECTED_NAMES = Object.freeze([PRIVATE_NAME, PUBLIC_NAME]);
const KEY_MAXIMUM_BYTES = 16 * 1024;

function lstatOrNull(fileSystem, candidate) {
  try { return fileSystem.lstatSync(candidate); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function assertSafeDirectoryPath(fileSystem, candidate, errorCode) {
  const absolute = path.resolve(candidate);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = fileSystem.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(errorCode);
  }
  if (fileSystem.realpathSync(absolute) !== absolute) throw new Error(errorCode);
  return absolute;
}

function keyPaths(runtimeRoot) {
  const keyRoot = path.join(runtimeRoot, 'release-signing');
  return Object.freeze({
    keyRoot,
    privatePath: path.join(keyRoot, PRIVATE_NAME),
    publicPath: path.join(keyRoot, PUBLIC_NAME),
  });
}

function runtimeOwnerUid(fileSystem, runtimeRoot) {
  const ownerUid = Number(fileSystem.lstatSync(runtimeRoot).uid);
  if (!Number.isSafeInteger(ownerUid) || ownerUid < 0) {
    throw new Error('release_integrity_runtime_root_owner_invalid');
  }
  return ownerUid;
}

function assertPrivateDirectoryIdentity(stat, expectedOwnerUid, errorCode) {
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || (stat.mode & 0o7777) !== 0o700
    || Number(stat.uid) !== expectedOwnerUid) throw new Error(errorCode);
}

function assertPrivateDirectoryChainUnchanged(
  snapshot,
  expectedOwnerUid,
  fileSystem,
  errorCode,
) {
  assertDirectoryChainUnchanged(snapshot, fileSystem);
  const selected = snapshot.at(-1);
  const stat = fileSystem.lstatSync(selected.path);
  assertPrivateDirectoryIdentity(stat, expectedOwnerUid, errorCode);
}

function readStableKeyFile(fileSystem, candidate, expectedMode, expectedOwnerUid) {
  let descriptor;
  let bytes;
  let succeeded = false;
  try {
    const pathBefore = fileSystem.lstatSync(candidate);
    if (!pathBefore.isFile() || pathBefore.isSymbolicLink()
      || Number(pathBefore.nlink) !== 1
      || (pathBefore.mode & 0o7777) !== expectedMode
      || Number(pathBefore.uid) !== expectedOwnerUid
      || pathBefore.size < 1 || pathBefore.size > KEY_MAXIMUM_BYTES) {
      throw new Error('release_integrity_key_file_unsafe');
    }
    descriptor = fileSystem.openSync(
      candidate,
      fileSystem.constants.O_RDONLY | (fileSystem.constants.O_NOFOLLOW || 0),
    );
    const before = fileSystem.fstatSync(descriptor);
    if (!before.isFile()
      || before.dev !== pathBefore.dev || before.ino !== pathBefore.ino
      || Number(before.nlink) !== 1
      || (before.mode & 0o7777) !== expectedMode
      || Number(before.uid) !== expectedOwnerUid
      || before.size < 1 || before.size > KEY_MAXIMUM_BYTES) {
      throw new Error('release_integrity_key_file_unsafe');
    }
    bytes = fileSystem.readFileSync(descriptor);
    const after = fileSystem.fstatSync(descriptor);
    const pathAfter = fileSystem.lstatSync(candidate);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || pathAfter.dev !== after.dev || pathAfter.ino !== after.ino
      || !pathAfter.isFile() || pathAfter.isSymbolicLink()
      || Number(pathAfter.nlink) !== 1
      || bytes.length !== before.size) {
      throw new Error('release_integrity_key_file_changed_during_read');
    }
    succeeded = true;
    return Object.freeze({
      bytes,
      identity: Object.freeze({ dev: before.dev, ino: before.ino }),
    });
  } finally {
    if (descriptor !== undefined) fileSystem.closeSync(descriptor);
    if (bytes && !succeeded) bytes.fill(0);
  }
}

function writeExclusiveKey(fileSystem, candidate, bytes, mode, expectedOwnerUid) {
  let descriptor;
  let identity;
  try {
    descriptor = fileSystem.openSync(
      candidate,
      fileSystem.constants.O_WRONLY | fileSystem.constants.O_CREAT
        | fileSystem.constants.O_EXCL | (fileSystem.constants.O_NOFOLLOW || 0),
      0o600,
    );
    const opened = fileSystem.fstatSync(descriptor);
    if (!opened.isFile() || Number(opened.nlink) !== 1) {
      throw new Error('release_integrity_key_output_unsafe');
    }
    identity = Object.freeze({ dev: opened.dev, ino: opened.ino });
    let offset = 0;
    while (offset < bytes.length) offset += fileSystem.writeSync(descriptor, bytes, offset);
    fileSystem.fchmodSync(descriptor, mode);
    fileSystem.fsyncSync(descriptor);
    const committed = fileSystem.fstatSync(descriptor);
    if (committed.dev !== opened.dev || committed.ino !== opened.ino
      || committed.size !== bytes.length || Number(committed.nlink) !== 1
      || (committed.mode & 0o7777) !== mode
      || Number(committed.uid) !== expectedOwnerUid) {
      throw new Error('release_integrity_key_output_postimage_mismatch');
    }
    fileSystem.closeSync(descriptor);
    descriptor = undefined;
    return identity;
  } catch (error) {
    if (descriptor !== undefined) {
      fileSystem.closeSync(descriptor);
      descriptor = undefined;
    }
    if (identity && !removeExact(fileSystem, candidate, identity)) {
      throw new Error(`release_integrity_key_output_rollback_incomplete:${error.message}`);
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fileSystem.closeSync(descriptor);
  }
}

function removeExact(fileSystem, candidate, identity) {
  const quarantine = `${candidate}.${process.pid}.${crypto.randomBytes(12).toString('hex')}.quarantine`;
  try {
    fileSystem.renameSync(candidate, quarantine);
    const moved = fileSystem.lstatSync(quarantine);
    if (!moved.isFile() || moved.isSymbolicLink()
      || moved.dev !== identity.dev || moved.ino !== identity.ino) {
      try {
        fileSystem.linkSync(quarantine, candidate);
        const restored = fileSystem.lstatSync(candidate);
        if (restored.dev === moved.dev && restored.ino === moved.ino) {
          removeExact(fileSystem, quarantine, { dev: moved.dev, ino: moved.ino });
        }
      } catch { /* Preserve both the current path and quarantined bytes. */ }
      return false;
    }
    fileSystem.unlinkSync(quarantine);
    return true;
  } catch {
    return false;
  }
}

function removeExactPairDirectory(fileSystem, directory, rootIdentity, publications) {
  const quarantine = `${directory}.${process.pid}.${crypto.randomBytes(12).toString('hex')}.quarantine`;
  try {
    fileSystem.renameSync(directory, quarantine);
    const moved = fileSystem.lstatSync(quarantine);
    if (!moved.isDirectory() || moved.isSymbolicLink()
      || moved.dev !== rootIdentity.dev || moved.ino !== rootIdentity.ino) return false;
    for (const publication of [...publications].reverse()) {
      if (!removeExact(
        fileSystem,
        path.join(quarantine, path.basename(publication.path)),
        publication.identity,
      )) return false;
    }
    if (fileSystem.readdirSync(quarantine).length !== 0) return false;
    fileSystem.rmdirSync(quarantine);
    return true;
  } catch {
    return false;
  }
}

function removeExactEmptyDirectory(fileSystem, directory, identity) {
  const quarantine = `${directory}.${process.pid}.${crypto.randomBytes(12).toString('hex')}.quarantine`;
  try {
    const selected = fileSystem.lstatSync(directory);
    if (!selected.isDirectory() || selected.isSymbolicLink()
      || selected.dev !== identity.dev || selected.ino !== identity.ino
      || fileSystem.readdirSync(directory).length !== 0) return false;
    fileSystem.renameSync(directory, quarantine);
    const moved = fileSystem.lstatSync(quarantine);
    if (!moved.isDirectory() || moved.isSymbolicLink()
      || moved.dev !== identity.dev || moved.ino !== identity.ino) return false;
    if (fileSystem.readdirSync(quarantine).length !== 0) return false;
    fileSystem.rmdirSync(quarantine);
    return lstatOrNull(fileSystem, quarantine) === null;
  } catch {
    return false;
  }
}

function setPrivateDirectoryModePinned(fileSystem, directory, expectedOwnerUid) {
  const before = fileSystem.lstatSync(directory);
  if (!before.isDirectory() || before.isSymbolicLink()
    || Number(before.uid) !== expectedOwnerUid) {
    throw new Error('release_integrity_key_staging_root_unsafe');
  }
  let descriptor;
  try {
    descriptor = fileSystem.openSync(
      directory,
      fileSystem.constants.O_RDONLY | (fileSystem.constants.O_DIRECTORY || 0)
        | (fileSystem.constants.O_NOFOLLOW || 0),
    );
    const opened = fileSystem.fstatSync(descriptor);
    if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino
      || Number(opened.uid) !== expectedOwnerUid) {
      throw new Error('release_integrity_key_staging_root_unsafe');
    }
    fileSystem.fchmodSync(descriptor, 0o700);
    const committed = fileSystem.fstatSync(descriptor);
    const pathAfter = fileSystem.lstatSync(directory);
    if (!committed.isDirectory()
      || committed.dev !== opened.dev || committed.ino !== opened.ino
      || pathAfter.dev !== committed.dev || pathAfter.ino !== committed.ino
      || (committed.mode & 0o7777) !== 0o700
      || Number(committed.uid) !== expectedOwnerUid) {
      throw new Error('release_integrity_key_staging_root_unsafe');
    }
    return Object.freeze({ dev: committed.dev, ino: committed.ino });
  } finally {
    if (descriptor !== undefined) fileSystem.closeSync(descriptor);
  }
}

function fsyncDirectory(fileSystem, directory, expectedIdentity = null) {
  const descriptor = fileSystem.openSync(
    directory,
    fileSystem.constants.O_RDONLY | (fileSystem.constants.O_DIRECTORY || 0)
      | (fileSystem.constants.O_NOFOLLOW || 0),
  );
  try {
    const stat = fileSystem.fstatSync(descriptor);
    if (!stat.isDirectory() || (expectedIdentity
      && (stat.dev !== expectedIdentity.dev || stat.ino !== expectedIdentity.ino))) {
      throw new Error('release_integrity_key_directory_identity_mismatch');
    }
    fileSystem.fsyncSync(descriptor);
  } finally {
    fileSystem.closeSync(descriptor);
  }
}

function publishStagedKeyFileNoClobber({
  fileSystem,
  source,
  destination,
  identity,
  expectedMode,
  expectedOwnerUid,
}) {
  fileSystem.linkSync(source, destination);
  const selected = fileSystem.lstatSync(destination);
  if (!selected.isFile() || selected.isSymbolicLink()
    || selected.dev !== identity.dev || selected.ino !== identity.ino
    || Number(selected.nlink) !== 2
    || (selected.mode & 0o7777) !== expectedMode
    || Number(selected.uid) !== expectedOwnerUid) {
    if (!removeExact(fileSystem, destination, identity)) {
      throw new Error('release_integrity_key_publish_rollback_incomplete');
    }
    throw new Error('release_integrity_key_publish_postimage_mismatch');
  }
  return Object.freeze({ path: destination, identity });
}

export const releaseIntegrityKeyStorage = Object.freeze({
  EXPECTED_NAMES,
  PRIVATE_NAME,
  PUBLIC_NAME,
  assertDirectoryChainUnchanged,
  assertPrivateDirectoryChainUnchanged,
  assertPrivateDirectoryIdentity,
  assertSafeDirectoryPath,
  fsyncDirectory,
  keyPaths,
  lstatOrNull,
  publishStagedKeyFileNoClobber,
  readStableKeyFile,
  removeExact,
  removeExactEmptyDirectory,
  removeExactPairDirectory,
  runtimeOwnerUid,
  setPrivateDirectoryModePinned,
  snapshotDirectoryChain,
  writeExclusiveKey,
});
