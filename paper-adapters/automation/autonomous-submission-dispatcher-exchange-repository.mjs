import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

import {
  autonomousSubmissionHandoffDatabasePath,
} from '../persistence/autonomous-submission-handoff-store.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;
const DIRECTORY_ONLY = fs.constants.O_DIRECTORY || 0;
const EXCHANGE_DIRECTORY_MODE = 0o2750;
const EXCHANGE_DIRECTORY_MODE_BIGINT = 0o2750n;

function sameDirectoryIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function pathBindsToDirectory(selected, expected) {
  try {
    const before = fs.lstatSync(selected, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()
      || !sameDirectoryIdentity(before, expected)
      || fs.realpathSync.native(selected) !== selected) return false;
    const after = fs.lstatSync(selected, { bigint: true });
    return after.isDirectory() && !after.isSymbolicLink()
      && sameDirectoryIdentity(after, expected);
  } catch {
    return false;
  }
}

function convergePinnedExchangeDirectory({ selected, create }) {
  if (DIRECTORY_ONLY === 0 || NO_FOLLOW === 0) {
    throw new Error('autonomous_submission_dispatcher_exchange_directory_unsafe');
  }
  let descriptor;
  try {
    try {
      descriptor = fs.openSync(
        selected,
        fs.constants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW,
      );
    } catch {
      throw new Error('autonomous_submission_dispatcher_exchange_directory_unsafe');
    }
    let opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isDirectory() || !pathBindsToDirectory(selected, opened)) {
      throw new Error('autonomous_submission_dispatcher_exchange_directory_unsafe');
    }
    const mode = opened.mode & 0o7777n;
    if (mode !== EXCHANGE_DIRECTORY_MODE_BIGINT) {
      const currentUid = typeof process.getuid === 'function'
        ? BigInt(process.getuid()) : null;
      if (!create || currentUid === null || opened.uid !== currentUid
        || (mode & ~EXCHANGE_DIRECTORY_MODE_BIGINT) !== 0n) {
        throw new Error('autonomous_submission_dispatcher_exchange_directory_unsafe');
      }
      fs.fchmodSync(descriptor, EXCHANGE_DIRECTORY_MODE);
      opened = fs.fstatSync(descriptor, { bigint: true });
    }
    if (!opened.isDirectory()
      || (opened.mode & 0o7777n) !== EXCHANGE_DIRECTORY_MODE_BIGINT
      || !pathBindsToDirectory(selected, opened)) {
      throw new Error('autonomous_submission_dispatcher_exchange_directory_unsafe');
    }
    return selected;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function baseDirectory(runtimeRoot) {
  const directory = path.dirname(autonomousSubmissionHandoffDatabasePath({ runtimeRoot }));
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || fs.realpathSync(directory) !== path.resolve(directory)
    || (stat.mode & 0o002) !== 0) {
    throw new Error('autonomous_submission_dispatcher_exchange_root_unsafe');
  }
  return directory;
}

export function autonomousSubmissionDispatcherExchangeDirectory({
  runtimeRoot,
  kind,
  create = false,
} = {}) {
  if (!['dispatcher-challenges', 'dispatcher-cycles'].includes(kind)) {
    throw new Error('autonomous_submission_dispatcher_exchange_kind_invalid');
  }
  const base = baseDirectory(runtimeRoot);
  const selected = path.join(base, kind);
  if (create) {
    try {
      fs.mkdirSync(selected, { mode: EXCHANGE_DIRECTORY_MODE });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  } else if (!fs.existsSync(selected)) {
    return selected;
  }
  return convergePinnedExchangeDirectory({ selected, create });
}

export function dispatcherExchangeFilePath({ runtimeRoot, kind, hash } = {}) {
  if (!SHA256.test(String(hash || ''))) {
    throw new Error('autonomous_submission_dispatcher_exchange_hash_invalid');
  }
  return path.join(autonomousSubmissionDispatcherExchangeDirectory({
    runtimeRoot,
    kind,
  }), `${hash.slice('sha256:'.length)}.json`);
}

export function readDispatcherExchangeDocument(candidate, {
  allowPublicationLink = false,
} = {}) {
  let descriptor;
  try {
    descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | NO_FOLLOW);
    const before = fs.fstatSync(descriptor);
    if (!before.isFile()
      || (before.nlink !== 1 && !(allowPublicationLink && before.nlink === 2))
      || before.size < 2
      || before.size > 1024 * 1024 || (before.mode & 0o002) !== 0) return null;
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || bytes.length !== before.size) return null;
    const value = JSON.parse(bytes.toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | NO_FOLLOW);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

function documentBytes(document) {
  return Buffer.from(`${JSON.stringify(document)}\n`, 'utf8');
}

function sameDocument(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

export function publishDispatcherExchangeDocument({
  runtimeRoot,
  kind,
  hash,
  document,
} = {}) {
  if (!SHA256.test(String(hash || ''))) {
    throw new Error('autonomous_submission_dispatcher_exchange_hash_invalid');
  }
  const directory = autonomousSubmissionDispatcherExchangeDirectory({
    runtimeRoot,
    kind,
    create: true,
  });
  const directoryStat = fs.lstatSync(directory);
  if (typeof process.getuid === 'function' && directoryStat.uid !== process.getuid()) {
    throw new Error('autonomous_submission_dispatcher_exchange_writer_not_owner');
  }
  const target = path.join(directory, `${String(hash).slice('sha256:'.length)}.json`);
  const bytes = documentBytes(document);
  const temporary = path.join(directory, `.publish-${String(hash).slice('sha256:'.length)}-${
    process.pid
  }-${crypto.randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW,
      0o640);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    try {
      fs.linkSync(temporary, target);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = readDispatcherExchangeDocument(target, {
        allowPublicationLink: true,
      });
      if (!existing || !sameDocument(existing, document)) {
        throw new Error('autonomous_submission_dispatcher_exchange_no_clobber_conflict');
      }
      return Object.freeze({ target, published: false });
    }
    fsyncDirectory(directory);
    return Object.freeze({ target, published: true });
  } catch (error) {
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
      fsyncDirectory(directory);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

export function listDispatcherExchangeDocuments({ runtimeRoot, kind, limit = 100 } = {}) {
  const directory = autonomousSubmissionDispatcherExchangeDirectory({ runtimeRoot, kind });
  if (!fs.existsSync(directory)) return Object.freeze([]);
  const bounded = Math.max(1, Math.min(1000, Number(limit) || 100));
  const names = fs.readdirSync(directory)
    .filter((name) => /^[0-9a-f]{64}\.json$/.test(name));
  if (names.length > 10_000) {
    throw new Error('autonomous_submission_dispatcher_exchange_inventory_limit_exceeded');
  }
  const records = names.map((name) => Object.freeze({
      path: path.join(directory, name),
      document: readDispatcherExchangeDocument(path.join(directory, name)),
    }));
  const observedTime = (record) => Date.parse(
    record.document?.challengedAt || record.document?.signedAt || '',
  );
  records.sort((left, right) => {
    const leftTime = observedTime(left);
    const rightTime = observedTime(right);
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime)
      && leftTime !== rightTime) return rightTime - leftTime;
    if (Number.isFinite(leftTime) !== Number.isFinite(rightTime)) {
      return Number.isFinite(leftTime) ? -1 : 1;
    }
    return right.path.localeCompare(left.path);
  });
  return Object.freeze(records.slice(0, bounded));
}
