import fs from 'node:fs';
import path from 'node:path';

import { fsyncDirectorySync } from '../runtime/durable-json-repository.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  verifyRetentionRemovalRecoveryBinding,
} from './runtime-retention-removal-recovery-contract.mjs';
import {
  retentionRemovalBindingIdentityMatches,
  stableRetentionRemovalContent,
} from './runtime-retention-removal-snapshot-repository.mjs';

const DIRECTORY_ONLY = fs.constants.O_DIRECTORY || 0;
const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;

function pinnedRemoveDirectoryContentsSync(directoryDescriptor, expectedDevice, boundary) {
  const directoryPath = `/proc/self/fd/${directoryDescriptor}`;
  const names = fs.readdirSync(directoryPath, { encoding: 'buffer' })
    .sort((left, right) => Buffer.compare(left, right));
  for (const rawName of names) {
    const name = rawName.toString('utf8');
    if (!Buffer.from(name, 'utf8').equals(rawName)
      || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
      throw new Error('runtime_retention_removal_recovery_tree_unsafe');
    }
    const child = path.join(directoryPath, name);
    const before = fs.lstatSync(child, { bigint: true });
    const directory = before.isDirectory() && !before.isSymbolicLink();
    if ((!directory && (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n))
      || before.dev !== expectedDevice) {
      throw new Error('runtime_retention_removal_recovery_tree_unsafe');
    }
    const descriptor = fs.openSync(
      child,
      fs.constants.O_RDONLY | (directory ? DIRECTORY_ONLY : 0) | NO_FOLLOW,
    );
    try {
      const opened = fs.fstatSync(descriptor, { bigint: true });
      if (opened.dev !== before.dev || opened.ino !== before.ino
        || (directory ? !opened.isDirectory() : !opened.isFile())) {
        throw new Error('runtime_retention_removal_recovery_tree_unsafe');
      }
      if (directory) pinnedRemoveDirectoryContentsSync(descriptor, expectedDevice, boundary);
      const current = fs.lstatSync(child, { bigint: true });
      const completed = fs.fstatSync(descriptor, { bigint: true });
      if (current.dev !== completed.dev || current.ino !== completed.ino
        || (!directory && completed.nlink !== 1n)) {
        throw new Error('runtime_retention_removal_recovery_tree_changed');
      }
      boundary();
      const afterBoundary = fs.lstatSync(child, { bigint: true });
      const pinnedAfterBoundary = fs.fstatSync(descriptor, { bigint: true });
      if (afterBoundary.dev !== pinnedAfterBoundary.dev
        || afterBoundary.ino !== pinnedAfterBoundary.ino
        || (directory ? !pinnedAfterBoundary.isDirectory() : !pinnedAfterBoundary.isFile())
        || (!directory && pinnedAfterBoundary.nlink !== 1n)) {
        throw new Error('runtime_retention_removal_recovery_tree_changed');
      }
      if (directory) fs.rmdirSync(child);
      else fs.unlinkSync(child);
      fs.fsyncSync(directoryDescriptor);
    } finally { fs.closeSync(descriptor); }
  }
}

export function removeRetentionRemovalCandidateSync({
  candidate,
  binding,
  expectedIdentity,
  beforeFirstIrreversible,
}) {
  verifyRetentionRemovalRecoveryBinding(binding);
  if (typeof beforeFirstIrreversible !== 'function') {
    throw new Error('runtime_retention_removal_recovery_boundary_required');
  }
  const observed = stableRetentionRemovalContent(candidate);
  if (observed.contentHash !== binding.contentHash
    || !expectedIdentity
    || hashRecord('RuntimeRetentionMemberIdentity', expectedIdentity)
      !== binding.memberIdentityHash
    || !retentionRemovalBindingIdentityMatches(observed.identity, binding, {
      allowModeChange: true,
    })) {
    throw new Error('runtime_retention_removal_recovery_preimage_changed');
  }
  const descriptor = fs.openSync(
    candidate,
    fs.constants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW,
  );
  const boundary = () => beforeFirstIrreversible();
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (opened.dev !== BigInt(binding.memberDevice)
      || opened.ino !== BigInt(binding.memberInode)) {
      throw new Error('runtime_retention_removal_recovery_preimage_changed');
    }
    pinnedRemoveDirectoryContentsSync(descriptor, opened.dev, boundary);
    const current = fs.lstatSync(candidate, { bigint: true });
    const completed = fs.fstatSync(descriptor, { bigint: true });
    if (current.dev !== completed.dev || current.ino !== completed.ino) {
      throw new Error('runtime_retention_removal_recovery_tree_changed');
    }
    boundary();
    const afterBoundary = fs.lstatSync(candidate, { bigint: true });
    const pinnedAfterBoundary = fs.fstatSync(descriptor, { bigint: true });
    if (afterBoundary.dev !== pinnedAfterBoundary.dev
      || afterBoundary.ino !== pinnedAfterBoundary.ino
      || !pinnedAfterBoundary.isDirectory()) {
      throw new Error('runtime_retention_removal_recovery_tree_changed');
    }
    fs.rmdirSync(candidate);
    if (fs.fstatSync(descriptor, { bigint: true }).nlink !== 0n) {
      throw new Error('runtime_retention_removal_recovery_tree_changed');
    }
  } finally { fs.closeSync(descriptor); }
  fsyncDirectorySync(path.dirname(candidate));
}
