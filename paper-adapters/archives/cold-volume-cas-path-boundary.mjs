import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DIRECTORY_ONLY = fs.constants.O_DIRECTORY || 0;
const NO_FOLLOW = fs.constants.O_NOFOLLOW;
const MAXIMUM_MANIFEST_BYTES = 16 * 1024 * 1024;

function directoryIdentity(stat) {
  return Object.freeze({
    dev: String(stat.dev),
    gid: String(stat.gid),
    ino: String(stat.ino),
    mode: String(stat.mode),
    uid: String(stat.uid),
  });
}

function sameIdentity(left, right) {
  return Boolean(left && right
    && Object.keys(left).every((key) => left[key] === right[key]));
}

function regularFileIdentity(stat) {
  return Object.freeze({
    ctimeNs: String(stat.ctimeNs), dev: String(stat.dev), ino: String(stat.ino),
    gid: String(stat.gid), mode: String(stat.mode), mtimeNs: String(stat.mtimeNs),
    nlink: String(stat.nlink), size: String(stat.size), uid: String(stat.uid),
  });
}

function boundaryError(errorCode, cause) {
  if (cause?.message === errorCode) return cause;
  return new Error(errorCode, { cause });
}

function safeChildName(name) {
  return typeof name === 'string' && name && name !== '.' && name !== '..'
    && path.basename(name) === name && !name.includes('/') && !name.includes('\\')
    && ![...name].some((character) => {
      const code = character.codePointAt(0);
      return code < 32 || code === 127;
    });
}

export function pinnedCasChildPath(directory, name, errorCode) {
  if (!safeChildName(name) || !Number.isInteger(directory?.descriptor)) {
    throw new Error(errorCode);
  }
  return path.join('/proc/self/fd', String(directory.descriptor), name);
}

function openDirectory({ entryPath, logicalPath, parent = null, name = null, errorCode }) {
  if (!Number.isInteger(NO_FOLLOW) || !Number.isInteger(DIRECTORY_ONLY)) {
    throw new Error(`${errorCode}:directory_no_follow_unavailable`);
  }
  let descriptor;
  try {
    const before = fs.lstatSync(entryPath, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error(errorCode);
    descriptor = fs.openSync(
      entryPath,
      fs.constants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW,
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const identity = directoryIdentity(opened);
    if (!opened.isDirectory()
      || !sameIdentity(directoryIdentity(before), identity)) throw new Error(errorCode);
    return Object.freeze({ descriptor, identity, logicalPath, name, parent });
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    throw boundaryError(errorCode, error);
  }
}

function assertPinnedDirectoryCurrent(directory, errorCode) {
  const entryPath = directory.parent
    ? pinnedCasChildPath(directory.parent, directory.name, errorCode)
    : '/';
  let selected;
  try { selected = fs.lstatSync(entryPath, { bigint: true }); }
  catch (error) { throw boundaryError(errorCode, error); }
  const opened = fs.fstatSync(directory.descriptor, { bigint: true });
  if (!selected.isDirectory() || selected.isSymbolicLink() || !opened.isDirectory()
    || !sameIdentity(directory.identity, directoryIdentity(selected))
    || !sameIdentity(directory.identity, directoryIdentity(opened))) {
    throw new Error(errorCode);
  }
}

export function assertPinnedCasDirectoryChain(chain, errorCode) {
  if (!Array.isArray(chain) || !chain.length) throw new Error(errorCode);
  for (const directory of chain) assertPinnedDirectoryCurrent(directory, errorCode);
}

export function assertPinnedCasOwnedDirectory(owner, directory, errorCode) {
  const ownerIdentity = owner?.identity;
  const identity = directory?.identity;
  if (!ownerIdentity || !identity
    || identity.uid !== ownerIdentity.uid
    || identity.gid !== ownerIdentity.gid
    || (BigInt(identity.mode) & 0o022n) !== 0n) throw new Error(errorCode);
}

export function closePinnedCasDirectoryChain(chain) {
  for (const directory of [...(chain || [])].reverse()) {
    try { fs.closeSync(directory.descriptor); } catch { /* Best-effort descriptor cleanup. */ }
  }
}

function chainForDirectory(directory) {
  const chain = [];
  let selected = directory;
  while (selected) {
    chain.unshift(selected);
    selected = selected.parent;
  }
  return chain;
}

function openChildDirectory(parent, name, { create, mode, errorCode }) {
  assertPinnedCasDirectoryChain(chainForDirectory(parent), errorCode);
  const entryPath = pinnedCasChildPath(parent, name, errorCode);
  let created = false;
  if (create) {
    try {
      fs.mkdirSync(entryPath, { mode });
      created = true;
      fs.fsyncSync(parent.descriptor);
    }
    catch (error) { if (error?.code !== 'EEXIST') throw boundaryError(errorCode, error); }
  }
  let child;
  try {
    child = openDirectory({
      entryPath,
      errorCode,
      logicalPath: path.join(parent.logicalPath, name),
      name,
      parent,
    });
    assertPinnedCasDirectoryChain(chainForDirectory(child), errorCode);
    if (created) fs.fsyncSync(child.descriptor);
    return child;
  } catch (error) {
    if (child) {
      try { fs.closeSync(child.descriptor); } catch { /* Best-effort descriptor cleanup. */ }
    }
    throw error;
  }
}

export function openPinnedCasChildDirectory(parent, name, {
  create = false,
  mode = 0o755,
  errorCode = 'cold_volume_cas_directory_unsafe',
} = {}) {
  try { return openChildDirectory(parent, name, { create, mode, errorCode }); }
  catch (error) { throw boundaryError(errorCode, error); }
}

export function openPinnedCasAbsoluteDirectoryChain(candidate, {
  create = false,
  mode = 0o755,
  errorCode = 'cold_volume_cas_root_unsafe',
} = {}) {
  if (typeof candidate !== 'string' || !candidate || candidate.includes('\0')) {
    throw new Error(errorCode);
  }
  const selected = path.resolve(candidate);
  let chain = [];
  try {
    chain = [openDirectory({
      entryPath: '/', errorCode, logicalPath: '/', name: null, parent: null,
    })];
    for (const segment of selected.split(path.sep).filter(Boolean)) {
      chain.push(openChildDirectory(chain.at(-1), segment, { create, mode, errorCode }));
    }
    return Object.freeze(chain);
  } catch (error) {
    closePinnedCasDirectoryChain(chain);
    throw boundaryError(errorCode, error);
  }
}

export function readPinnedCasDirectory(chain, errorCode) {
  assertPinnedCasDirectoryChain(chain, errorCode);
  let rows;
  try {
    rows = fs.readdirSync(path.join('/proc/self/fd', String(chain.at(-1).descriptor)));
  } catch (error) {
    throw boundaryError(errorCode, error);
  }
  assertPinnedCasDirectoryChain(chain, errorCode);
  return rows;
}

export function errorCausedByCode(error, code) {
  let selected = error;
  while (selected) {
    if (selected.code === code) return true;
    selected = selected.cause;
  }
  return false;
}

export function openPinnedCasRegularFile(candidate, errorCode, {
  directoryChain = null,
  name = null,
} = {}) {
  if (!Number.isInteger(NO_FOLLOW)) throw new Error(`${errorCode}:no_follow_unavailable`);
  if (directoryChain) assertPinnedCasDirectoryChain(directoryChain, errorCode);
  const descriptorPath = directoryChain
    ? pinnedCasChildPath(directoryChain.at(-1), name, errorCode)
    : path.resolve(candidate);
  const logicalPath = directoryChain
    ? path.join(directoryChain.at(-1).logicalPath, name)
    : descriptorPath;
  let descriptor;
  try {
    const before = fs.lstatSync(descriptorPath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) throw new Error(errorCode);
    descriptor = fs.openSync(descriptorPath, fs.constants.O_RDONLY | NO_FOLLOW);
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const identity = regularFileIdentity(opened);
    if (!opened.isFile()
      || !sameIdentity(regularFileIdentity(before), identity)) throw new Error(errorCode);
    if (directoryChain) assertPinnedCasDirectoryChain(directoryChain, errorCode);
    return Object.freeze({
      descriptor, descriptorPath, directoryChain, identity, path: logicalPath,
    });
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    throw error;
  }
}

export function assertPinnedCasFileCurrent(pinned, errorCode) {
  if (pinned.directoryChain) assertPinnedCasDirectoryChain(pinned.directoryChain, errorCode);
  let selected;
  try { selected = fs.lstatSync(pinned.descriptorPath, { bigint: true }); }
  catch (error) { throw boundaryError(errorCode, error); }
  const opened = fs.fstatSync(pinned.descriptor, { bigint: true });
  if (!selected.isFile() || selected.isSymbolicLink() || !opened.isFile()
    || !sameIdentity(pinned.identity, regularFileIdentity(selected))
    || !sameIdentity(pinned.identity, regularFileIdentity(opened))) throw new Error(errorCode);
  if (pinned.directoryChain) assertPinnedCasDirectoryChain(pinned.directoryChain, errorCode);
}

export function assertPinnedCasPublishedFile(pinned, errorCode) {
  assertPinnedCasFileCurrent(pinned, errorCode);
  const parentIdentity = pinned.directoryChain?.at(-1)?.identity;
  if ((BigInt(pinned.identity.mode) & 0o7777n) !== 0o444n
    || pinned.identity.nlink !== '1'
    || !parentIdentity
    || pinned.identity.uid !== parentIdentity.uid
    || pinned.identity.gid !== parentIdentity.gid) throw new Error(errorCode);
}

export function hashPinnedCasFile(pinned, errorCode) {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
  let offset = 0;
  for (;;) {
    const bytesRead = fs.readSync(pinned.descriptor, buffer, 0, buffer.length, offset);
    if (!bytesRead) break;
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  if (String(offset) !== pinned.identity.size) throw new Error(errorCode);
  assertPinnedCasFileCurrent(pinned, errorCode);
  return `sha256:${hash.digest('hex')}`;
}

export function duplicatePinnedCasFileForRead(pinned, errorCode) {
  let descriptor;
  try {
    descriptor = fs.openSync(
      path.join('/proc/self/fd', String(pinned.descriptor)),
      fs.constants.O_RDONLY,
    );
    const identity = regularFileIdentity(fs.fstatSync(descriptor, { bigint: true }));
    if (!sameIdentity(pinned.identity, identity)) throw new Error(errorCode);
    return Object.freeze({
      descriptor,
      descriptorPath: pinned.descriptorPath,
      directoryChain: pinned.directoryChain,
      identity,
      path: pinned.path,
    });
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    throw boundaryError(errorCode, error);
  }
}

export function openPinnedCasJsonRecord(candidate, errorCode, boundary = {}) {
  const { requirePublished = false, ...fileBoundary } = boundary;
  const pinned = openPinnedCasRegularFile(candidate, errorCode, fileBoundary);
  try {
    const size = BigInt(pinned.identity.size);
    if (size < 2n || size > BigInt(MAXIMUM_MANIFEST_BYTES)) throw new Error(errorCode);
    const bytes = fs.readFileSync(pinned.descriptor);
    if (String(bytes.length) !== pinned.identity.size) throw new Error(errorCode);
    if (requirePublished) assertPinnedCasPublishedFile(pinned, errorCode);
    else assertPinnedCasFileCurrent(pinned, errorCode);
    return Object.freeze({
      document: JSON.parse(bytes.toString('utf8')),
      fileHash: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
      pinned,
    });
  } catch (error) {
    fs.closeSync(pinned.descriptor);
    throw boundaryError(errorCode, error);
  }
}

export function readPinnedCasJsonRecord(candidate, errorCode, boundary = {}) {
  const opened = openPinnedCasJsonRecord(candidate, errorCode, boundary);
  try {
    return Object.freeze({ document: opened.document, fileHash: opened.fileHash });
  } finally { fs.closeSync(opened.pinned.descriptor); }
}
