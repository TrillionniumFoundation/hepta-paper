import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const HASH_BUFFER_BYTES = 1024 * 1024;
const SHEBANG_BYTES = 4096;

function statIdentity(stat) {
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.nlink,
    stat.uid,
    stat.gid,
    stat.rdev,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
  ].join(':');
}

function configuredError(code) {
  return new Error(String(code));
}

export function createProcessFileContentHasher({
  maximumCacheEntries = 0,
  regularFileRequiredError = null,
  changedDuringHashError = null,
} = {}) {
  const cache = new Map();
  return function fileContentHash(candidate) {
    const descriptor = fs.openSync(candidate, 'r');
    try {
      const identityRequired = maximumCacheEntries > 0
        || regularFileRequiredError !== null || changedDuringHashError !== null;
      const before = identityRequired
        ? fs.fstatSync(descriptor, { bigint: true }) : null;
      if (regularFileRequiredError !== null && !before.isFile()) {
        throw configuredError(regularFileRequiredError);
      }
      const identity = before === null ? null : statIdentity(before);
      const cached = identity === null ? null : cache.get(identity);
      if (cached) {
        cache.delete(identity);
        cache.set(identity, cached);
        return cached;
      }
      const digest = crypto.createHash('sha256');
      const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
      let bytesRead;
      do {
        bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
        if (bytesRead > 0) digest.update(buffer.subarray(0, bytesRead));
      } while (bytesRead > 0);
      if (changedDuringHashError !== null
        && statIdentity(fs.fstatSync(descriptor, { bigint: true })) !== identity) {
        throw configuredError(changedDuringHashError);
      }
      const contentHash = `sha256:${digest.digest('hex')}`;
      if (identity !== null && maximumCacheEntries > 0) {
        cache.set(identity, contentHash);
        if (cache.size > maximumCacheEntries) cache.delete(cache.keys().next().value);
      }
      return contentHash;
    } finally { fs.closeSync(descriptor); }
  };
}

export function inspectProcessExecutableFileIdentity({
  executable,
  fileContentHash,
  stat = fs.statSync(executable),
} = {}) {
  return Object.freeze({
    contentHash: fileContentHash(executable),
    device: String(stat.dev),
    inode: String(stat.ino),
    uid: Number(stat.uid),
  });
}

export function processExecutableFileIdentityMatches({
  executable,
  expected,
  fileContentHash,
  stat = fs.statSync(executable),
  includeUid = false,
} = {}) {
  return String(stat.dev) === expected.device
    && String(stat.ino) === expected.inode
    && (!includeUid || Number(stat.uid) === expected.uid)
    && fileContentHash(executable) === expected.contentHash;
}

function executableOnPath(program, environment, notFoundError) {
  for (const directory of String(environment.PATH || '')
    .split(path.delimiter).filter(Boolean)) {
    const candidate = path.resolve(directory, program);
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile() && (stat.mode & 0o111) !== 0) return fs.realpathSync(candidate);
    } catch { /* keep searching */ }
  }
  throw configuredError(notFoundError);
}

export function processInterpreterIdentityHash({
  executable,
  environment,
  fileContentHash,
  hashDomain,
  invalidInterpreterError,
  interpreterNotFoundError,
} = {}) {
  const descriptor = fs.openSync(executable, 'r');
  const buffer = Buffer.alloc(SHEBANG_BYTES);
  let bytes;
  try { bytes = fs.readSync(descriptor, buffer, 0, buffer.length, 0); }
  finally { fs.closeSync(descriptor); }
  const firstLine = buffer.subarray(0, bytes).toString('utf8').split(/\r?\n/, 1)[0];
  if (!firstLine.startsWith('#!')) return null;
  const words = firstLine.slice(2).trim().split(/\s+/).filter(Boolean);
  if (!words.length) throw configuredError(invalidInterpreterError);
  const launcher = fs.realpathSync(words[0]);
  const executables = [launcher];
  if (path.basename(launcher) === 'env') {
    const program = words.find((word, index) => index > 0 && !word.startsWith('-'));
    if (!program) throw configuredError(invalidInterpreterError);
    executables.push(executableOnPath(program, environment, interpreterNotFoundError));
  }
  const payload = executables.map((candidate) => {
    const stat = fs.statSync(candidate);
    return Object.freeze({
      realpath: candidate,
      device: String(stat.dev),
      inode: String(stat.ino),
      contentHash: fileContentHash(candidate),
    });
  });
  return hashRecord(hashDomain, payload);
}
