import fs from 'node:fs';
import path from 'node:path';

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  retentionMemberHash,
  retentionMemberIdentity,
  retentionPathExists,
} from './runtime-retention-scope-repository.mjs';
import {
  verifyRetentionRemovalRecoveryBinding,
} from './runtime-retention-removal-recovery-contract.mjs';

const DIRECTORY_ONLY = fs.constants.O_DIRECTORY || 0;
const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;

function exactDirectoryNames(candidate) {
  return fs.readdirSync(candidate, { encoding: 'buffer' })
    .sort((left, right) => Buffer.compare(left, right))
    .map((raw) => {
      const name = raw.toString('utf8');
      if (!Buffer.from(name, 'utf8').equals(raw)
        || !name || name === '.' || name === '..'
        || name.includes('/') || name.includes('\0')) {
        throw new Error('runtime_retention_removal_recovery_tree_unsafe');
      }
      return name;
    });
}

function exactOwner(value) {
  const owner = Number(value);
  if (!Number.isSafeInteger(owner) || BigInt(owner) !== value) {
    throw new Error('runtime_retention_removal_recovery_tree_unsafe');
  }
  return owner;
}

function synchronizeSnapshotNodeMetadata(source, destination, expectedDevice) {
  const sourceBefore = fs.lstatSync(source, { bigint: true });
  const destinationBefore = fs.lstatSync(destination, { bigint: true });
  const directory = sourceBefore.isDirectory() && !sourceBefore.isSymbolicLink();
  const file = sourceBefore.isFile() && !sourceBefore.isSymbolicLink();
  if ((!directory && !file)
    || destinationBefore.dev !== expectedDevice
    || destinationBefore.isSymbolicLink()
    || directory !== destinationBefore.isDirectory()
    || file !== destinationBefore.isFile()
    || (file && (sourceBefore.nlink !== 1n || destinationBefore.nlink !== 1n))) {
    throw new Error('runtime_retention_removal_recovery_tree_unsafe');
  }
  if (directory) {
    const sourceNames = exactDirectoryNames(source);
    const destinationNames = exactDirectoryNames(destination);
    if (JSON.stringify(sourceNames) !== JSON.stringify(destinationNames)) {
      throw new Error('runtime_retention_removal_recovery_tree_unsafe');
    }
    for (const name of sourceNames) {
      synchronizeSnapshotNodeMetadata(
        path.join(source, name),
        path.join(destination, name),
        expectedDevice,
      );
    }
  }
  const descriptor = fs.openSync(
    destination,
    fs.constants.O_RDONLY | NO_FOLLOW | (directory ? DIRECTORY_ONLY : 0),
  );
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const sourceAfter = fs.lstatSync(source, { bigint: true });
    if (opened.dev !== destinationBefore.dev || opened.ino !== destinationBefore.ino
      || sourceAfter.dev !== sourceBefore.dev || sourceAfter.ino !== sourceBefore.ino
      || sourceAfter.mode !== sourceBefore.mode || sourceAfter.uid !== sourceBefore.uid
      || sourceAfter.gid !== sourceBefore.gid) {
      throw new Error('runtime_retention_removal_recovery_tree_changed');
    }
    fs.fchownSync(descriptor, exactOwner(sourceAfter.uid), exactOwner(sourceAfter.gid));
    fs.fchmodSync(descriptor, Number(sourceAfter.mode & 0o777n));
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
}

export function synchronizeRetentionRemovalSnapshotMetadataSync({
  source,
  destination,
  expectedDevice,
}) {
  synchronizeSnapshotNodeMetadata(
    path.resolve(source),
    path.resolve(destination),
    expectedDevice,
  );
}

export function safeRetentionRemovalRecoveryDirectorySync(candidate, expectedDevice = null) {
  const stat = fs.lstatSync(candidate, { bigint: true });
  const currentUid = process.getuid?.();
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || (expectedDevice !== null && stat.dev !== expectedDevice)
    || (currentUid !== undefined && stat.uid !== BigInt(currentUid))
    || (Number(stat.mode) & 0o077) !== 0
    || (Number(stat.mode) & 0o700) !== 0o700
    || stat.nlink < 2n) {
    throw new Error('runtime_retention_removal_recovery_tree_unsafe');
  }
  return stat;
}

export function sealAndSyncRetentionRemovalTree(candidate, device = null) {
  const root = fs.lstatSync(candidate, { bigint: true });
  if (!root.isDirectory() || root.isSymbolicLink()
    || (device !== null && root.dev !== device)) {
    throw new Error('runtime_retention_removal_recovery_tree_unsafe');
  }
  for (const name of fs.readdirSync(candidate).sort()) {
    const child = path.join(candidate, name);
    const stat = fs.lstatSync(child, { bigint: true });
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      sealAndSyncRetentionRemovalTree(child, root.dev);
      continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.dev !== root.dev) {
      throw new Error('runtime_retention_removal_recovery_tree_unsafe');
    }
    const descriptor = fs.openSync(child, fs.constants.O_RDONLY | NO_FOLLOW);
    try {
      const opened = fs.fstatSync(descriptor, { bigint: true });
      if (opened.dev !== stat.dev || opened.ino !== stat.ino || !opened.isFile()) {
        throw new Error('runtime_retention_removal_recovery_tree_unsafe');
      }
      fs.fchmodSync(descriptor, Number(opened.mode) & 0o5555);
      fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }
  }
  const descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW);
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (opened.dev !== root.dev || opened.ino !== root.ino) {
      throw new Error('runtime_retention_removal_recovery_tree_unsafe');
    }
    fs.fchmodSync(descriptor, Number(opened.mode) & 0o5555);
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
}

export function stableRetentionRemovalContent(candidate) {
  const before = retentionMemberIdentity(candidate);
  const first = retentionMemberHash(candidate);
  const second = retentionMemberHash(candidate);
  const after = retentionMemberIdentity(candidate);
  if (first !== second || before.dev !== after.dev || before.ino !== after.ino
    || before.mode !== after.mode || before.mtimeNs !== after.mtimeNs) {
    throw new Error('runtime_retention_removal_recovery_tree_changed');
  }
  return Object.freeze({ contentHash: first, identity: after });
}

export function assertSealedRetentionRemovalRecovery(candidate, contentHash) {
  const stat = fs.lstatSync(candidate, { bigint: true });
  const observed = stableRetentionRemovalContent(candidate);
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || (Number(stat.mode) & 0o222) !== 0 || observed.contentHash !== contentHash) {
    throw new Error('runtime_retention_removal_recovery_snapshot_invalid');
  }
  return observed;
}

export function assertOriginalRetentionRemovalCandidate(candidate, binding, expectedIdentity) {
  const observed = stableRetentionRemovalContent(candidate);
  const stableFields = ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'nlink', 'entryKind'];
  if (observed.contentHash !== binding.contentHash
    || !expectedIdentity
    || hashRecord('RuntimeRetentionMemberIdentity', expectedIdentity)
      !== binding.memberIdentityHash
    || stableFields.some((field) => String(observed.identity[field])
      !== String(expectedIdentity[field]))) {
    throw new Error('runtime_retention_removal_recovery_preimage_changed');
  }
}

export function retentionRemovalBindingIdentityMatches(
  identity,
  binding,
  { allowModeChange = false } = {},
) {
  return identity.dev === binding.memberDevice
    && identity.ino === binding.memberInode
    && (allowModeChange || identity.mode === binding.memberMode)
    && identity.size === binding.memberSize
    && identity.mtimeNs === binding.memberMtimeNs
    && identity.nlink === binding.memberNlink
    && identity.entryKind === binding.memberEntryKind;
}

export function validateRetentionRemovalCandidateTree(candidate, expectedDevice) {
  const root = fs.lstatSync(candidate, { bigint: true });
  if (!root.isDirectory() || root.isSymbolicLink() || root.dev !== expectedDevice) {
    throw new Error('runtime_retention_removal_recovery_tree_unsafe');
  }
  const descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW);
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (opened.dev !== root.dev || opened.ino !== root.ino) {
      throw new Error('runtime_retention_removal_recovery_tree_unsafe');
    }
    const descriptorPath = `/proc/self/fd/${descriptor}`;
    for (const rawName of fs.readdirSync(descriptorPath, { encoding: 'buffer' })) {
      const name = rawName.toString('utf8');
      if (!Buffer.from(name, 'utf8').equals(rawName)
        || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
        throw new Error('runtime_retention_removal_recovery_tree_unsafe');
      }
      const child = path.join(descriptorPath, name);
      const stat = fs.lstatSync(child, { bigint: true });
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        validateRetentionRemovalCandidateTree(child, expectedDevice);
      } else if (!stat.isFile() || stat.isSymbolicLink()
        || stat.dev !== expectedDevice || stat.nlink !== 1n) {
        throw new Error('runtime_retention_removal_recovery_tree_unsafe');
      }
    }
  } finally { fs.closeSync(descriptor); }
}

function makeRemovalCandidateDirectoriesWritable(candidate, expectedDevice) {
  const descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW);
  try {
    const root = fs.fstatSync(descriptor, { bigint: true });
    if (!root.isDirectory() || root.dev !== expectedDevice) {
      throw new Error('runtime_retention_removal_recovery_tree_unsafe');
    }
    fs.fchmodSync(descriptor, (Number(root.mode) & 0o7777) | 0o700);
    fs.fsyncSync(descriptor);
    const descriptorPath = `/proc/self/fd/${descriptor}`;
    for (const name of fs.readdirSync(descriptorPath).sort()) {
      const child = path.join(descriptorPath, name);
      const stat = fs.lstatSync(child, { bigint: true });
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        makeRemovalCandidateDirectoriesWritable(child, expectedDevice);
      } else if (!stat.isFile() || stat.isSymbolicLink()
        || stat.dev !== expectedDevice || stat.nlink !== 1n) {
        throw new Error('runtime_retention_removal_recovery_tree_unsafe');
      }
    }
  } finally { fs.closeSync(descriptor); }
}

export function unsealRetentionRemovalCandidateSync({
  candidate,
  binding,
  expectedIdentity,
}) {
  verifyRetentionRemovalRecoveryBinding(binding);
  assertOriginalRetentionRemovalCandidate(candidate, binding, expectedIdentity);
  const expectedDevice = BigInt(binding.memberDevice);
  validateRetentionRemovalCandidateTree(candidate, expectedDevice);
  makeRemovalCandidateDirectoriesWritable(candidate, expectedDevice);
  const observed = stableRetentionRemovalContent(candidate);
  if (observed.contentHash !== binding.contentHash
    || !retentionRemovalBindingIdentityMatches(observed.identity, binding, {
      allowModeChange: true,
    })
    || (Number(observed.identity.mode) & 0o700) !== 0o700) {
    throw new Error('runtime_retention_removal_recovery_preimage_changed');
  }
  return observed;
}

export function assertRetentionRemovalRecoveryResidueSubset(
  candidate,
  reference,
  binding,
  { root = true } = {},
) {
  const candidateStat = fs.lstatSync(candidate, { bigint: true });
  const referenceStat = fs.lstatSync(reference, { bigint: true });
  if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink()
    || !referenceStat.isDirectory() || referenceStat.isSymbolicLink()
    || candidateStat.dev !== BigInt(binding.memberDevice)
    || (root && candidateStat.ino !== BigInt(binding.memberInode))) {
    throw new Error('runtime_retention_removal_recovery_residue_invalid');
  }
  for (const rawName of fs.readdirSync(candidate, { encoding: 'buffer' })) {
    const name = rawName.toString('utf8');
    if (!Buffer.from(name, 'utf8').equals(rawName)
      || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
      throw new Error('runtime_retention_removal_recovery_residue_invalid');
    }
    const child = path.join(candidate, name);
    const referenceChild = path.join(reference, name);
    if (!retentionPathExists(referenceChild)) {
      throw new Error('runtime_retention_removal_recovery_residue_invalid');
    }
    const childStat = fs.lstatSync(child, { bigint: true });
    const referenceChildStat = fs.lstatSync(referenceChild, { bigint: true });
    if (childStat.isDirectory() && !childStat.isSymbolicLink()
      && referenceChildStat.isDirectory() && !referenceChildStat.isSymbolicLink()) {
      assertRetentionRemovalRecoveryResidueSubset(
        child,
        referenceChild,
        binding,
        { root: false },
      );
    } else if (!childStat.isFile() || childStat.isSymbolicLink()
      || !referenceChildStat.isFile() || referenceChildStat.isSymbolicLink()
      || childStat.dev !== BigInt(binding.memberDevice) || childStat.nlink !== 1n
      || retentionMemberHash(child) !== retentionMemberHash(referenceChild)) {
      throw new Error('runtime_retention_removal_recovery_residue_invalid');
    }
  }
}
