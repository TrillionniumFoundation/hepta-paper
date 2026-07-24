import fs from 'node:fs';
import path from 'node:path';

import {
  autonomousSubmissionHandoffDatabasePath,
} from '../persistence/autonomous-submission-handoff-store.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;

function openCapability(candidate, flags) {
  let descriptor;
  try {
    descriptor = fs.openSync(candidate, flags | NO_FOLLOW);
    const stat = fs.fstatSync(descriptor);
    return stat.isFile() && stat.nlink === 1;
  } catch { return false; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

function nativeStoreDisposition(candidate) {
  try {
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) return 'invalid';
    if (openCapability(candidate, fs.constants.O_RDWR)) return 'writable';
    return openCapability(candidate, fs.constants.O_RDONLY)
      ? 'read_only' : 'inaccessible';
  } catch (error) {
    return error?.code === 'ENOENT' ? 'absent' : 'invalid';
  }
}

export function inspectAutonomousSubmissionDispatcherStoragePreflight({
  runtimeRoot,
} = {}) {
  const nativeDatabasePath = path.join(path.resolve(String(runtimeRoot || '')),
    'hepta-paper.sqlite');
  const handoffDatabasePath = autonomousSubmissionHandoffDatabasePath({ runtimeRoot });
  // The strongest deployment does not mount the native database at all. A
  // regular but non-writable native database remains supported for systemd's
  // exact read-only path sandbox; either state proves no native write capability.
  const nativeStoreDispositionValue = nativeStoreDisposition(nativeDatabasePath);
  const nativeStoreInaccessibleOrReadOnlyVerified = [
    'absent', 'inaccessible', 'read_only',
  ].includes(nativeStoreDispositionValue);
  const handoffStoreWriteVerified = openCapability(
    handoffDatabasePath, fs.constants.O_RDONLY,
  ) && openCapability(handoffDatabasePath, fs.constants.O_RDWR);
  const storageLayout = Object.freeze({
    version: 1,
    kind: 'AutonomousSubmissionDispatcherStorageLayout',
    nativeStoreRelativePath: 'hepta-paper.sqlite',
    nativeStoreDisposition: nativeStoreDispositionValue,
    handoffStoreRelativePath:
      'autonomous-research/submission-handoff/submission-handoff.sqlite',
    handoffStoreWriteVerified,
  });
  return Object.freeze({
    ready: nativeStoreInaccessibleOrReadOnlyVerified && handoffStoreWriteVerified,
    nativeStoreInaccessibleOrReadOnlyVerified,
    nativeStoreDisposition: nativeStoreDispositionValue,
    handoffStoreWriteVerified,
    storageLayoutHash: hashRecord(
      'AutonomousSubmissionDispatcherStorageLayout', storageLayout,
    ),
    blockers: Object.freeze([
      ...(nativeStoreInaccessibleOrReadOnlyVerified ? []
        : ['autonomous_submission_dispatcher_native_store_write_capability_present']),
      ...(handoffStoreWriteVerified ? []
        : ['autonomous_submission_dispatcher_handoff_store_not_writable']),
    ]),
  });
}

export function autonomousSubmissionDispatcherProcessIdentity() {
  const identity = Object.freeze({
    pid: process.pid,
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    gid: typeof process.getgid === 'function' ? process.getgid() : null,
    groups: Object.freeze(typeof process.getgroups === 'function'
      ? [...process.getgroups()].sort((left, right) => left - right) : []),
  });
  return Object.freeze({
    ...identity,
    processIdentityHash: hashRecord(
      'AutonomousSubmissionDispatcherProcessIdentity', identity,
    ),
  });
}
