import fs from 'node:fs';
import path from 'node:path';

import {
  assertPinnedCasDirectoryChain,
  assertPinnedCasFileCurrent,
  assertPinnedCasOwnedDirectory,
  closePinnedCasDirectoryChain,
  openPinnedCasAbsoluteDirectoryChain,
  openPinnedCasChildDirectory,
  openPinnedCasRegularFile,
  pinnedCasChildPath,
} from './cold-volume-cas-path-boundary.mjs';
import { publishPinnedCasSourceFile } from './cold-volume-cas-publication-repository.mjs';

const IMPORT_STAGING_ERROR = 'cold_volume_cas_import_staging_unsafe';
const IMPORT_LEASE_ERROR = 'cold_volume_cas_import_lease_unavailable';
const IMPORT_LEASE_NAME = '.cold-volume-cas-import.lock';
const NO_FOLLOW = fs.constants.O_NOFOLLOW;

function pinnedDirectoryChain(directory) {
  const chain = [];
  let selected = directory;
  while (selected) {
    chain.unshift(selected);
    selected = selected.parent;
  }
  return Object.freeze(chain);
}

function assertPrivateImportDirectory(owner, directory) {
  assertPinnedCasOwnedDirectory(owner, directory, IMPORT_STAGING_ERROR);
  assertPinnedCasDirectoryChain(pinnedDirectoryChain(directory), IMPORT_STAGING_ERROR);
  const stat = fs.fstatSync(directory.descriptor, { bigint: true });
  if (!stat.isDirectory()
    || directory.identity.dev !== owner.identity.dev
    || (stat.mode & 0o7777n) !== 0o700n) throw new Error(IMPORT_STAGING_ERROR);
}

function regularFileIdentity(stat) {
  return Object.freeze({
    ctimeNs: String(stat.ctimeNs), dev: String(stat.dev), gid: String(stat.gid),
    ino: String(stat.ino), mode: String(stat.mode), mtimeNs: String(stat.mtimeNs),
    nlink: String(stat.nlink), size: String(stat.size), uid: String(stat.uid),
  });
}

function sameRegularFileIdentity(left, right) {
  return Boolean(left && right
    && Object.keys(left).every((key) => left[key] === right[key]));
}

function assertLeaseIdentity(stagingDirectory, identity) {
  if (!identity
    || identity.dev !== stagingDirectory.identity.dev
    || identity.uid !== stagingDirectory.identity.uid
    || identity.gid !== stagingDirectory.identity.gid
    || identity.nlink !== '1'
    || identity.size !== '0'
    || (BigInt(identity.mode) & 0o7777n) !== 0o600n) throw new Error(IMPORT_LEASE_ERROR);
}

function removeExactLeaseEntry(stagingDirectory, descriptorPath, expectedIdentity) {
  const selected = fs.lstatSync(descriptorPath, { bigint: true });
  if (!selected.isFile() || selected.isSymbolicLink()
    || !sameRegularFileIdentity(regularFileIdentity(selected), expectedIdentity)) {
    throw new Error(IMPORT_LEASE_ERROR);
  }
  fs.unlinkSync(descriptorPath);
  fs.fsyncSync(stagingDirectory.descriptor);
}

function leaseError(error) {
  return error?.message === IMPORT_LEASE_ERROR
    ? error
    : new Error(IMPORT_LEASE_ERROR, { cause: error });
}

export function acquireColdVolumeCasImportLease(stagingDirectory) {
  if (!Number.isInteger(NO_FOLLOW)) throw new Error(IMPORT_LEASE_ERROR);
  const directoryChain = pinnedDirectoryChain(stagingDirectory);
  const descriptorPath = pinnedCasChildPath(
    stagingDirectory, IMPORT_LEASE_NAME, IMPORT_LEASE_ERROR,
  );
  let createdDescriptor;
  let createdIdentity;
  let pinned;
  try {
    assertPinnedCasDirectoryChain(directoryChain, IMPORT_LEASE_ERROR);
    createdDescriptor = fs.openSync(
      descriptorPath,
      fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    const created = fs.fstatSync(createdDescriptor, { bigint: true });
    if (!created.isFile()) throw new Error(IMPORT_LEASE_ERROR);
    createdIdentity = regularFileIdentity(created);
    assertLeaseIdentity(stagingDirectory, createdIdentity);
    fs.fsyncSync(createdDescriptor);
    fs.fsyncSync(stagingDirectory.descriptor);
    pinned = openPinnedCasRegularFile(null, IMPORT_LEASE_ERROR, {
      directoryChain,
      name: IMPORT_LEASE_NAME,
    });
    assertPinnedCasFileCurrent(pinned, IMPORT_LEASE_ERROR);
    if (!sameRegularFileIdentity(createdIdentity, pinned.identity)) {
      throw new Error(IMPORT_LEASE_ERROR);
    }
    fs.closeSync(createdDescriptor);
    createdDescriptor = undefined;
    return Object.freeze({ pinned });
  } catch (error) {
    let cleanupError = null;
    if (pinned?.descriptor !== undefined) {
      try { fs.closeSync(pinned.descriptor); } catch (selected) { cleanupError = selected; }
    }
    if (createdIdentity) {
      try { removeExactLeaseEntry(stagingDirectory, descriptorPath, createdIdentity); }
      catch (selected) { cleanupError ||= selected; }
    }
    if (createdDescriptor !== undefined) {
      try { fs.closeSync(createdDescriptor); } catch (selected) { cleanupError ||= selected; }
    }
    const blocked = leaseError(error);
    if (cleanupError) {
      throw combineColdVolumeCasImportCleanupError(blocked, cleanupError);
    }
    throw blocked;
  }
}

export function coldVolumeCasImportArchivePath(tempDirectory, name) {
  return pinnedCasChildPath(tempDirectory, name, IMPORT_STAGING_ERROR);
}

export function combineColdVolumeCasImportCleanupError(primaryError, cleanupError) {
  if (!primaryError) return cleanupError;
  return new AggregateError(
    [primaryError, cleanupError],
    `${primaryError.message};${cleanupError.message}`,
    { cause: primaryError },
  );
}

export function inspectColdVolumeCasImportArchive(tempDirectory, name) {
  const candidate = coldVolumeCasImportArchivePath(tempDirectory, name);
  try {
    const stat = fs.lstatSync(candidate, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(IMPORT_STAGING_ERROR);
    return regularFileIdentity(stat);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export function openColdVolumeCasImportStaging({ casRootChain, stagingRoot }) {
  if (stagingRoot === null) {
    const directory = openPinnedCasChildDirectory(casRootChain.at(-1), '.staging', {
      create: true,
      mode: 0o700,
      errorCode: IMPORT_STAGING_ERROR,
    });
    try {
      assertPrivateImportDirectory(casRootChain.at(-1), directory);
      return Object.freeze({ closeChain: [directory], directory });
    } catch (error) {
      closePinnedCasDirectoryChain([directory]);
      throw error;
    }
  }
  const closeChain = openPinnedCasAbsoluteDirectoryChain(stagingRoot, {
    errorCode: IMPORT_STAGING_ERROR,
  });
  try {
    assertPrivateImportDirectory(casRootChain.at(-1), closeChain.at(-1));
    return Object.freeze({ closeChain, directory: closeChain.at(-1) });
  } catch (error) {
    closePinnedCasDirectoryChain(closeChain);
    throw error;
  }
}

export function openColdVolumeCasImportTempDirectory(stagingDirectory) {
  const prefix = pinnedCasChildPath(
    stagingDirectory,
    `hepta-cold-cas-import-${process.pid}-`,
    IMPORT_STAGING_ERROR,
  );
  let createdPath;
  let directory;
  try {
    createdPath = fs.mkdtempSync(prefix);
    const name = path.basename(createdPath);
    directory = openPinnedCasChildDirectory(stagingDirectory, name, {
      errorCode: IMPORT_STAGING_ERROR,
    });
    assertPrivateImportDirectory(stagingDirectory, directory);
    return Object.freeze({ directory, name });
  } catch (error) {
    if (directory) closePinnedCasDirectoryChain([directory]);
    if (createdPath) {
      try { fs.rmdirSync(createdPath); } catch { /* Best effort; never delete an unknown entry. */ }
    }
    throw new Error(IMPORT_STAGING_ERROR, { cause: error });
  }
}

export function publishColdVolumeCasImportArchive({
  directoryChain,
  errorCode,
  expectedFileHash,
  name,
  sourceDirectory,
  sourceName,
  sourcePath,
}) {
  return publishPinnedCasSourceFile(
    directoryChain,
    name,
    sourcePath,
    expectedFileHash,
    errorCode,
    {
      consumeSource: true,
      sourceDirectoryChain: pinnedDirectoryChain(sourceDirectory),
      sourceName,
    },
  );
}

export function releaseColdVolumeCasImportLease(lease) {
  const pinned = lease?.pinned;
  const stagingDirectory = pinned?.directoryChain?.at(-1);
  try {
    if (!pinned || !stagingDirectory) throw new Error(IMPORT_LEASE_ERROR);
    assertPinnedCasFileCurrent(pinned, IMPORT_LEASE_ERROR);
    assertLeaseIdentity(stagingDirectory, pinned.identity);
    fs.unlinkSync(pinned.descriptorPath);
    const unlinked = fs.fstatSync(pinned.descriptor, { bigint: true });
    if (!unlinked.isFile() || unlinked.nlink !== 0n) throw new Error(IMPORT_LEASE_ERROR);
    fs.fsyncSync(stagingDirectory.descriptor);
  } catch (error) {
    throw leaseError(error);
  } finally {
    if (pinned?.descriptor !== undefined) fs.closeSync(pinned.descriptor);
  }
}

export function removeColdVolumeCasImportArchive(tempDirectory, name, expectedIdentity) {
  if (!expectedIdentity) return;
  const candidate = coldVolumeCasImportArchivePath(tempDirectory, name);
  let selected;
  try { selected = fs.lstatSync(candidate, { bigint: true }); }
  catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (!selected.isFile() || selected.isSymbolicLink()
    || !sameRegularFileIdentity(regularFileIdentity(selected), expectedIdentity)) {
    throw new Error(IMPORT_STAGING_ERROR);
  }
  fs.unlinkSync(candidate);
  fs.fsyncSync(tempDirectory.descriptor);
}

export function removeColdVolumeCasImportTempDirectory(stagingDirectory, tempDirectory) {
  assertPrivateImportDirectory(stagingDirectory, tempDirectory.directory);
  const tempPath = pinnedCasChildPath(
    stagingDirectory, tempDirectory.name, IMPORT_STAGING_ERROR,
  );
  fs.rmdirSync(tempPath);
  fs.fsyncSync(stagingDirectory.descriptor);
}

export function sealColdVolumeCasImportArchive(tempDirectory, name) {
  const pinned = openPinnedCasRegularFile(null, IMPORT_STAGING_ERROR, {
    directoryChain: pinnedDirectoryChain(tempDirectory),
    name,
  });
  try {
    fs.fsyncSync(pinned.descriptor);
    fs.fchmodSync(pinned.descriptor, 0o444);
    fs.fsyncSync(pinned.descriptor);
  } finally { fs.closeSync(pinned.descriptor); }
  const identity = inspectColdVolumeCasImportArchive(tempDirectory, name);
  if (!identity || (BigInt(identity.mode) & 0o7777n) !== 0o444n) {
    throw new Error(IMPORT_STAGING_ERROR);
  }
  return identity;
}
