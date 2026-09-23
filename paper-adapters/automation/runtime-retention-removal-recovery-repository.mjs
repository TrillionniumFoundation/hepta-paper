import fs from 'node:fs';
import path from 'node:path';

import { fsyncDirectorySync } from '../runtime/durable-json-repository.mjs';
import { readRegularJsonFileSync } from '../runtime/pinned-file-reader.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  assertTrustedRetentionTombstoneCapability,
} from './runtime-retention-trusted-receipt-repository.mjs';
import {
  retentionMemberIdentity,
  retentionPathExists,
} from './runtime-retention-scope-repository.mjs';
import {
  assertOriginalRetentionRemovalCandidate as assertOriginalCandidate,
  assertRetentionRemovalRecoveryResidueSubset as assertRecoveryResidueSubset,
  assertSealedRetentionRemovalRecovery as assertSealedRecovery,
  retentionRemovalBindingIdentityMatches as bindingIdentityMatches,
  safeRetentionRemovalRecoveryDirectorySync as safeDirectory,
  sealAndSyncRetentionRemovalTree as sealAndSyncTree,
  stableRetentionRemovalContent as stableContentHash,
  synchronizeRetentionRemovalSnapshotMetadataSync as synchronizeSnapshotMetadata,
  validateRetentionRemovalCandidateTree,
} from './runtime-retention-removal-snapshot-repository.mjs';
import {
  createRetentionRemovalMutationMarker,
  createRetentionRemovalPreparingJournal,
  createRetentionRemovalRecoveryJournal,
  retentionRemovalRecoveryStageName,
  verifyRetentionRemovalRecoveryBinding,
  verifyRetentionRemovalRecoveryJournal,
  verifyRetentionRemovalMutationMarker,
} from './runtime-retention-removal-recovery-contract.mjs';
import {
  moveRetentionRemovalNoReplaceSync,
  removeRetentionRemovalTreeDurablySync,
  writeFixedRetentionRemovalJsonSync,
} from './runtime-retention-removal-storage-repository.mjs';

const DIRECTORY_ONLY = fs.constants.O_DIRECTORY || 0;
const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;
const LIVE_STAGE_CAPABILITIES = new WeakMap();

function openRecoveryRoot(binding, expectedDevice) {
  const runtimeRoot = path.resolve(binding.runtimeRoot);
  const retentionRoot = path.join(runtimeRoot, 'retention');
  for (const [index, candidate] of [runtimeRoot, retentionRoot].entries()) {
    const stat = fs.lstatSync(candidate, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('runtime_retention_removal_recovery_root_unsafe');
    }
    if (index === 1) {
      const currentUid = process.getuid?.();
      if ((currentUid !== undefined && stat.uid !== BigInt(currentUid))
        || (Number(stat.mode) & 0o022) !== 0 || stat.nlink < 2n) {
        throw new Error('runtime_retention_removal_recovery_root_unsafe');
      }
    }
  }
  const retentionBefore = fs.lstatSync(retentionRoot, { bigint: true });
  const retentionDescriptor = fs.openSync(
    retentionRoot,
    fs.constants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW,
  );
  try {
    const retentionOpened = fs.fstatSync(retentionDescriptor, { bigint: true });
    if (retentionOpened.dev !== retentionBefore.dev
      || retentionOpened.ino !== retentionBefore.ino
      || fs.realpathSync.native(`/proc/self/fd/${retentionDescriptor}`)
        !== fs.realpathSync.native(retentionRoot)) {
      throw new Error('runtime_retention_removal_recovery_root_unsafe');
    }
    const recoveryRoot = path.join(`/proc/self/fd/${retentionDescriptor}`, 'removal-recovery');
    let created = false;
    try {
      fs.mkdirSync(recoveryRoot, { mode: 0o700 });
      created = true;
    } catch (error) { if (error?.code !== 'EEXIST') throw error; }
    if (created) fs.fsyncSync(retentionDescriptor);
    const before = safeDirectory(recoveryRoot, expectedDevice);
    const descriptor = fs.openSync(
      recoveryRoot,
      fs.constants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW,
    );
    try {
      const opened = fs.fstatSync(descriptor, { bigint: true });
      if (opened.dev !== before.dev || opened.ino !== before.ino
        || fs.realpathSync.native(`/proc/self/fd/${descriptor}`)
          !== fs.realpathSync.native(recoveryRoot)) {
        throw new Error('runtime_retention_removal_recovery_root_unsafe');
      }
      return Object.freeze({
        descriptor,
        descriptorPath: `/proc/self/fd/${descriptor}`,
        device: opened.dev,
        inode: opened.ino,
      });
    } catch (error) {
      fs.closeSync(descriptor);
      throw error;
    }
  } finally { fs.closeSync(retentionDescriptor); }
}

function stageLocations(recoveryRoot, binding) {
  const stageName = retentionRemovalRecoveryStageName(binding);
  const stage = path.join(recoveryRoot.descriptorPath, stageName);
  return Object.freeze({
    stageName,
    stage,
    journal: path.join(stage, 'journal.json'),
    mutation: path.join(stage, 'mutation.json'),
    mutationNext: path.join(stage, 'mutation.next'),
    rollback: path.join(stage, 'rollback'),
    rollbackPreparing: path.join(stage, 'rollback.preparing'),
  });
}

function descriptorStageLocations(locations, descriptor) {
  const stage = `/proc/self/fd/${descriptor}`;
  return Object.freeze({
    ...locations,
    stage,
    journal: path.join(stage, 'journal.json'),
    mutation: path.join(stage, 'mutation.json'),
    mutationNext: path.join(stage, 'mutation.next'),
    rollback: path.join(stage, 'rollback'),
    rollbackPreparing: path.join(stage, 'rollback.preparing'),
  });
}

function createLiveStageCapability({ binding, namedStage, descriptor, identity }) {
  const capability = Object.freeze({});
  LIVE_STAGE_CAPABILITIES.set(capability, Object.freeze({
    bindingHash: hashRecord('RuntimeRetentionRemovalRecoveryBinding', binding),
    namedStage,
    descriptor,
    device: identity.dev,
    inode: identity.ino,
  }));
  return capability;
}

export function assertRetentionRemovalLiveStageCapabilitySync(capability, binding) {
  verifyRetentionRemovalRecoveryBinding(binding);
  const expected = LIVE_STAGE_CAPABILITIES.get(capability);
  if (!expected || expected.bindingHash !== hashRecord(
    'RuntimeRetentionRemovalRecoveryBinding',
    binding,
  )) {
    throw new Error('runtime_retention_removal_recovery_stage_capability_invalid');
  }
  const named = safeDirectory(expected.namedStage, expected.device);
  const opened = fs.fstatSync(expected.descriptor, { bigint: true });
  if (named.dev !== expected.device || named.ino !== expected.inode
    || opened.dev !== expected.device || opened.ino !== expected.inode
    || fs.realpathSync.native(expected.namedStage)
      !== fs.realpathSync.native(`/proc/self/fd/${expected.descriptor}`)) {
    throw new Error('runtime_retention_removal_recovery_stage_changed');
  }
  return Object.freeze({ dev: opened.dev, ino: opened.ino });
}

function assertBoundOriginalCandidate(candidate, binding) {
  const observed = stableContentHash(candidate);
  if (observed.contentHash !== binding.contentHash
    || !bindingIdentityMatches(observed.identity, binding)) {
    throw new Error('runtime_retention_removal_recovery_preimage_changed');
  }
  return observed;
}

function cleanupPreparingStage(recoveryRoot, locations, binding, stageIdentity) {
  const before = safeDirectory(locations.stage, recoveryRoot.device);
  if (before.dev !== stageIdentity.dev || before.ino !== stageIdentity.ino) {
    throw new Error('runtime_retention_removal_recovery_tree_unsafe');
  }
  const descriptor = fs.openSync(
    locations.stage,
    fs.constants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW,
  );
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error('runtime_retention_removal_recovery_tree_unsafe');
    }
    const stage = `/proc/self/fd/${descriptor}`;
    const names = fs.readdirSync(stage).sort();
    const journalPath = path.join(stage, 'journal.json');
    const allowed = new Set([
      'journal.json', 'journal.next', 'rollback.preparing', 'rollback',
    ]);
    if (names.some((name) => !allowed.has(name))
      || names.includes('rollback.preparing') && names.includes('rollback')) {
      throw new Error('runtime_retention_removal_recovery_tree_unsafe');
    }
    const journal = readRegularJsonFileSync(journalPath);
    if (journal) {
      verifyRetentionRemovalRecoveryJournal(journal, binding, opened, {
        expectedStatus: 'runtime_retention_removal_preparing',
      });
    } else if (names.some((name) => name !== 'journal.next')) {
      throw new Error('runtime_retention_removal_recovery_journal_invalid');
    }
    for (const control of ['journal.next']) {
      const candidate = path.join(stage, control);
      if (!retentionPathExists(candidate)) continue;
      const stat = fs.lstatSync(candidate, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink()
        || stat.dev !== opened.dev || stat.nlink !== 1n) {
        throw new Error('runtime_retention_removal_recovery_tree_unsafe');
      }
    }
    const rollback = path.join(stage, 'rollback');
    if (retentionPathExists(rollback)) {
      assertSealedRecovery(rollback, binding.contentHash);
    }
    const preparing = path.join(stage, 'rollback.preparing');
    if (retentionPathExists(preparing)) {
      validateRetentionRemovalCandidateTree(preparing, opened.dev);
    }
    for (const name of names) {
      if (name !== 'journal.json') {
        removeRetentionRemovalTreeDurablySync(path.join(stage, name));
      }
    }
    fs.fsyncSync(descriptor);
    if (journal) {
      verifyRetentionRemovalRecoveryJournal(
        readRegularJsonFileSync(journalPath),
        binding,
        opened,
        { expectedStatus: 'runtime_retention_removal_preparing' },
      );
      fs.unlinkSync(journalPath);
      fs.fsyncSync(descriptor);
    }
    const current = fs.lstatSync(locations.stage, { bigint: true });
    const completed = fs.fstatSync(descriptor, { bigint: true });
    if (current.dev !== completed.dev || current.ino !== completed.ino) {
      throw new Error('runtime_retention_removal_recovery_tree_unsafe');
    }
    fs.rmdirSync(locations.stage);
    if (fs.fstatSync(descriptor, { bigint: true }).nlink !== 0n) {
      throw new Error('runtime_retention_removal_recovery_tree_unsafe');
    }
  } finally { fs.closeSync(descriptor); }
  fs.fsyncSync(recoveryRoot.descriptor);
}

function finalizeStage(
  recoveryRoot,
  locations,
  binding,
  {
    journalMayBeMissing = false,
    expectedStageIdentity = null,
    referenceSource = null,
  } = {},
) {
  if (!retentionPathExists(locations.stage)) return;
  const before = safeDirectory(locations.stage, recoveryRoot.device);
  const stageDescriptor = fs.openSync(
    locations.stage,
    fs.constants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW,
  );
  try {
    const opened = fs.fstatSync(stageDescriptor, { bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino
      || (expectedStageIdentity
        && (opened.dev !== expectedStageIdentity.dev
          || opened.ino !== expectedStageIdentity.ino))
      || fs.realpathSync.native(`/proc/self/fd/${stageDescriptor}`)
        !== fs.realpathSync.native(locations.stage)) {
      throw new Error('runtime_retention_removal_recovery_tree_unsafe');
    }
    const pinnedStage = `/proc/self/fd/${stageDescriptor}`;
    const journalPath = path.join(pinnedStage, 'journal.json');
    const mutationPath = path.join(pinnedStage, 'mutation.json');
    const names = fs.readdirSync(pinnedStage).sort();
    const journal = readRegularJsonFileSync(journalPath);
    if (journal) verifyRetentionRemovalRecoveryJournal(journal, binding, opened);
    else if (names.length !== 0 || (!journalMayBeMissing && names.length !== 0)) {
      throw new Error('runtime_retention_removal_recovery_journal_invalid');
    }
    if (retentionPathExists(mutationPath)) {
      verifyRetentionRemovalMutationMarker(
        readRegularJsonFileSync(mutationPath),
        binding,
      );
    }
    const allowed = new Set([
      'journal.json', 'mutation.json', 'rollback',
      ...(referenceSource ? ['package', 'residue'] : []),
    ]);
    if (names.some((name) => !allowed.has(name))) {
      throw new Error('runtime_retention_removal_recovery_tree_unsafe');
    }
    if (retentionPathExists(path.join(pinnedStage, 'rollback'))) {
      assertSealedRecovery(path.join(pinnedStage, 'rollback'), binding.contentHash);
    }
    for (const residueName of ['package', 'residue']) {
      const residue = path.join(pinnedStage, residueName);
      if (retentionPathExists(residue)) {
        if (!referenceSource) {
          throw new Error('runtime_retention_removal_recovery_residue_invalid');
        }
        assertRecoveryResidueSubset(residue, referenceSource, binding);
      }
    }
    for (const name of names) {
      if (name !== 'journal.json') {
        removeRetentionRemovalTreeDurablySync(path.join(pinnedStage, name));
      }
    }
    fs.fsyncSync(stageDescriptor);
    if (retentionPathExists(journalPath)) {
      verifyRetentionRemovalRecoveryJournal(
        readRegularJsonFileSync(journalPath),
        binding,
        opened,
      );
      fs.unlinkSync(journalPath);
      fs.fsyncSync(stageDescriptor);
    }
    const current = fs.lstatSync(locations.stage, { bigint: true });
    const completed = fs.fstatSync(stageDescriptor, { bigint: true });
    if (current.dev !== completed.dev || current.ino !== completed.ino) {
      throw new Error('runtime_retention_removal_recovery_tree_unsafe');
    }
  } finally { fs.closeSync(stageDescriptor); }
  fs.rmdirSync(locations.stage);
  fs.fsyncSync(recoveryRoot.descriptor);
}

export function prepareRetentionRemovalRecoverySync({
  candidate,
  binding,
  expectedIdentity,
}) {
  verifyRetentionRemovalRecoveryBinding(binding);
  const resolvedCandidate = path.resolve(String(candidate || ''));
  const canonicalParent = path.dirname(binding.sourcePath);
  const allowedCandidates = new Set([
    binding.sourcePath,
    path.join(canonicalParent, binding.quarantineName),
  ]);
  let physicalCandidate = null;
  try { physicalCandidate = fs.realpathSync.native(resolvedCandidate); } catch { /* validated below */ }
  if (!allowedCandidates.has(physicalCandidate)) {
    throw new Error('runtime_retention_removal_recovery_preimage_changed');
  }
  const candidateStat = fs.lstatSync(resolvedCandidate, { bigint: true });
  if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink()) {
    throw new Error('runtime_retention_removal_recovery_preimage_changed');
  }
  const recoveryRoot = openRecoveryRoot(binding, candidateStat.dev);
  const namedLocations = stageLocations(recoveryRoot, binding);
  let locations = namedLocations;
  let retained = false;
  let stageCreated = false;
  let createdStageIdentity = null;
  let stageDescriptor = null;
  try {
    if (retentionPathExists(namedLocations.stage)) {
      throw new Error('runtime_retention_removal_recovery_pending');
    }
    fs.mkdirSync(namedLocations.stage, { mode: 0o700 });
    stageCreated = true;
    createdStageIdentity = safeDirectory(namedLocations.stage, candidateStat.dev);
    stageDescriptor = fs.openSync(
      namedLocations.stage,
      fs.constants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW,
    );
    const openedStage = fs.fstatSync(stageDescriptor, { bigint: true });
    if (openedStage.dev !== createdStageIdentity.dev
      || openedStage.ino !== createdStageIdentity.ino) {
      throw new Error('runtime_retention_removal_recovery_tree_unsafe');
    }
    locations = descriptorStageLocations(namedLocations, stageDescriptor);
    fs.fsyncSync(recoveryRoot.descriptor);
    writeFixedRetentionRemovalJsonSync(
      locations.journal,
      'journal.next',
      createRetentionRemovalPreparingJournal(binding, createdStageIdentity),
      { mode: 0o400 },
    );
    verifyRetentionRemovalRecoveryJournal(
      readRegularJsonFileSync(locations.journal),
      binding,
      createdStageIdentity,
      { expectedStatus: 'runtime_retention_removal_preparing' },
    );
    fs.fsyncSync(recoveryRoot.descriptor);
    fs.cpSync(resolvedCandidate, locations.rollbackPreparing, {
      recursive: true, dereference: false, errorOnExist: true,
      force: false, preserveTimestamps: true,
    });
    synchronizeSnapshotMetadata({
      source: resolvedCandidate,
      destination: locations.rollbackPreparing,
      expectedDevice: candidateStat.dev,
    });
    sealAndSyncTree(locations.rollbackPreparing, candidateStat.dev);
    assertSealedRecovery(locations.rollbackPreparing, binding.contentHash);
    assertOriginalCandidate(resolvedCandidate, binding, expectedIdentity);
    fsyncDirectorySync(locations.stage);
    fs.renameSync(locations.rollbackPreparing, locations.rollback);
    fsyncDirectorySync(locations.stage);
    writeFixedRetentionRemovalJsonSync(
      locations.journal,
      'journal.next',
      createRetentionRemovalRecoveryJournal(binding, createdStageIdentity),
      { mode: 0o400 },
    );
    verifyRetentionRemovalRecoveryJournal(
      readRegularJsonFileSync(locations.journal),
      binding,
      createdStageIdentity,
    );
    fs.fsyncSync(recoveryRoot.descriptor);
    retained = true;
    let closed = false;
    let mutationStarted = false;
    const stageCapability = createLiveStageCapability({
      binding,
      namedStage: namedLocations.stage,
      descriptor: stageDescriptor,
      identity: createdStageIdentity,
    });
    return Object.freeze({
      binding,
      locations,
      stageCapability,
      assertLiveStage() {
        return assertRetentionRemovalLiveStageCapabilitySync(stageCapability, binding);
      },
      beginMutation({ sourceTreeIdentityHash = null } = {}) {
        if (closed) throw new Error('runtime_retention_removal_recovery_closed');
        if (mutationStarted) return;
        assertRetentionRemovalLiveStageCapabilitySync(stageCapability, binding);
        const currentStageIdentity = safeDirectory(
          namedLocations.stage,
          recoveryRoot.device,
        );
        if (currentStageIdentity.dev !== createdStageIdentity.dev
          || currentStageIdentity.ino !== createdStageIdentity.ino) {
          throw new Error('runtime_retention_removal_recovery_tree_unsafe');
        }
        verifyRetentionRemovalRecoveryJournal(
          readRegularJsonFileSync(locations.journal),
          binding,
          currentStageIdentity,
        );
        if (retentionPathExists(locations.mutation)) {
          verifyRetentionRemovalMutationMarker(
            readRegularJsonFileSync(locations.mutation),
            binding,
          );
        } else {
          writeFixedRetentionRemovalJsonSync(
            locations.mutation,
            'mutation.next',
            createRetentionRemovalMutationMarker(binding, { sourceTreeIdentityHash }),
            { mode: 0o400 },
          );
          verifyRetentionRemovalMutationMarker(
            readRegularJsonFileSync(locations.mutation),
            binding,
          );
        }
        fsyncDirectorySync(locations.stage);
        fs.fsyncSync(recoveryRoot.descriptor);
        mutationStarted = true;
      },
      close() {
        if (closed) return;
        closed = true;
        LIVE_STAGE_CAPABILITIES.delete(stageCapability);
        fs.closeSync(stageDescriptor);
        fs.closeSync(recoveryRoot.descriptor);
      },
    });
  } catch (error) {
    if (stageCreated && retentionPathExists(namedLocations.stage)) {
      if (stageDescriptor !== null) {
        fs.closeSync(stageDescriptor);
        stageDescriptor = null;
      }
      try {
        finalizeStage(recoveryRoot, namedLocations, binding, {
          journalMayBeMissing: true,
          expectedStageIdentity: createdStageIdentity,
        });
      }
      catch { /* Leave a fail-closed staging tree for operator inspection. */ }
    }
    throw error;
  } finally {
    if (!retained) {
      if (stageDescriptor !== null) fs.closeSync(stageDescriptor);
      fs.closeSync(recoveryRoot.descriptor);
    }
  }
}

export function finalizeRetentionRemovalRecoverySync(binding, tombstoneCapability) {
  verifyRetentionRemovalRecoveryBinding(binding);
  assertTrustedRetentionTombstoneCapability(
    tombstoneCapability,
    binding.runtimeRetentionIntentReceiptHash,
  );
  const recoveryRoot = openRecoveryRoot(binding, BigInt(binding.memberDevice));
  try {
    const locations = stageLocations(recoveryRoot, binding);
    if (!retentionPathExists(locations.stage)) return;
    let referenceSource = null;
    if (retentionPathExists(locations.rollback)) {
      assertSealedRecovery(locations.rollback, binding.contentHash);
      referenceSource = locations.rollback;
    } else if (retentionPathExists(binding.sourcePath)) {
      assertSealedRecovery(binding.sourcePath, binding.contentHash);
      referenceSource = binding.sourcePath;
    }
    finalizeStage(recoveryRoot, locations, binding, { referenceSource });
  } finally { fs.closeSync(recoveryRoot.descriptor); }
}

export function recoverRetentionRemovalSync({
  binding,
  parentDescriptor,
  parentDescriptorPath,
}) {
  verifyRetentionRemovalRecoveryBinding(binding);
  if (parentDescriptorPath !== `/proc/self/fd/${parentDescriptor}`) {
    throw new Error('runtime_retention_removal_recovery_parent_invalid');
  }
  const parentStat = fs.fstatSync(parentDescriptor, { bigint: true });
  if (parentStat.dev !== BigInt(binding.memberDevice)) {
    throw new Error('runtime_retention_removal_recovery_parent_invalid');
  }
  const canonicalParent = path.dirname(binding.sourcePath);
  if (fs.realpathSync.native(parentDescriptorPath)
    !== fs.realpathSync.native(canonicalParent)) {
    throw new Error('runtime_retention_removal_recovery_parent_invalid');
  }
  const recoveryRoot = openRecoveryRoot(binding, parentStat.dev);
  const locations = stageLocations(recoveryRoot, binding);
  try {
    if (!retentionPathExists(locations.stage)) return Object.freeze({ status: 'absent' });
    const stageIdentity = safeDirectory(locations.stage, parentStat.dev);
    const source = path.join(parentDescriptorPath, path.basename(binding.sourcePath));
    const quarantine = path.join(parentDescriptorPath, binding.quarantineName);
    const sourceExists = retentionPathExists(source);
    const quarantineExists = retentionPathExists(quarantine);
    if (sourceExists && quarantineExists) {
      throw new Error('runtime_retention_removal_recovery_source_collision');
    }
    const journal = readRegularJsonFileSync(locations.journal);
    if (!journal || journal.status === 'runtime_retention_removal_preparing') {
      const preserved = sourceExists ? source : quarantineExists ? quarantine : null;
      if (!preserved) {
        throw new Error('runtime_retention_removal_recovery_preimage_changed');
      }
      assertBoundOriginalCandidate(preserved, binding);
      cleanupPreparingStage(recoveryRoot, locations, binding, stageIdentity);
      return Object.freeze({ status: 'source_preserved' });
    }
    verifyRetentionRemovalRecoveryJournal(
      journal,
      binding,
      stageIdentity,
    );
    if (retentionPathExists(locations.mutationNext)) {
      if (retentionPathExists(locations.mutation)) {
        throw new Error('runtime_retention_removal_mutation_marker_invalid');
      }
      const nextStat = fs.lstatSync(locations.mutationNext, { bigint: true });
      if (!nextStat.isFile() || nextStat.isSymbolicLink()
        || nextStat.dev !== stageIdentity.dev || nextStat.nlink !== 1n) {
        throw new Error('runtime_retention_removal_mutation_marker_invalid');
      }
      const preserved = sourceExists ? source : quarantineExists ? quarantine : null;
      if (!preserved) {
        throw new Error('runtime_retention_removal_mutation_marker_invalid');
      }
      assertBoundOriginalCandidate(preserved, binding);
      fs.unlinkSync(locations.mutationNext);
      fsyncDirectorySync(locations.stage);
    }
    const mutationStarted = retentionPathExists(locations.mutation);
    if (mutationStarted) {
      verifyRetentionRemovalMutationMarker(
        readRegularJsonFileSync(locations.mutation),
        binding,
      );
    }
    const preserved = sourceExists ? source : quarantineExists ? quarantine : null;
    if (preserved) {
      const observed = stableContentHash(preserved);
      if (observed.contentHash === binding.contentHash
        && bindingIdentityMatches(observed.identity, binding)
        && !mutationStarted) {
        finalizeStage(recoveryRoot, locations, binding);
        return Object.freeze({ status: 'source_preserved' });
      }
      if (sourceExists) {
        if (!retentionPathExists(locations.rollback)
          && observed.contentHash === binding.contentHash) {
          sealAndSyncTree(source, parentStat.dev);
          assertSealedRecovery(source, binding.contentHash);
          finalizeStage(recoveryRoot, locations, binding, { referenceSource: source });
          return Object.freeze({ status: 'source_restored' });
        }
        if (!mutationStarted
          || !bindingIdentityMatches(observed.identity, binding, { allowModeChange: true })) {
          throw new Error('runtime_retention_removal_recovery_source_collision');
        }
      }
      if (!sourceExists && (observed.identity.dev !== binding.memberDevice
        || observed.identity.ino !== binding.memberInode)) {
        throw new Error('runtime_retention_removal_recovery_source_collision');
      }
      const preservedStat = fs.lstatSync(preserved, { bigint: true });
      fs.chmodSync(preserved, (Number(preservedStat.mode) & 0o7777) | 0o700);
      fsyncDirectorySync(preserved);
      const stageDescriptor = fs.openSync(
        locations.stage,
        fs.constants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW,
      );
      try {
        moveRetentionRemovalNoReplaceSync(
          parentDescriptor,
          sourceExists ? path.basename(binding.sourcePath) : binding.quarantineName,
          stageDescriptor,
          'residue',
        );
        fs.fsyncSync(parentDescriptor);
        fs.fsyncSync(stageDescriptor);
      } finally { fs.closeSync(stageDescriptor); }
      const residue = path.join(locations.stage, 'residue');
      const residueIdentity = retentionMemberIdentity(residue);
      if (retentionPathExists(preserved)
        || residueIdentity.dev !== binding.memberDevice
        || residueIdentity.ino !== binding.memberInode) {
        throw new Error('runtime_retention_removal_recovery_residue_invalid');
      }
    }
    sealAndSyncTree(locations.rollback, parentStat.dev);
    assertSealedRecovery(locations.rollback, binding.contentHash);
    fs.chmodSync(locations.rollback, 0o700);
    fsyncDirectorySync(locations.rollback);
    fsyncDirectorySync(locations.stage);
    const stageDescriptor = fs.openSync(
      locations.stage,
      fs.constants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW,
    );
    try {
      moveRetentionRemovalNoReplaceSync(
        stageDescriptor,
        'rollback',
        parentDescriptor,
        path.basename(binding.sourcePath),
      );
      fs.fsyncSync(parentDescriptor);
      fs.fsyncSync(stageDescriptor);
    } finally { fs.closeSync(stageDescriptor); }
    if (retentionPathExists(locations.rollback) || !retentionPathExists(source)) {
      throw new Error('runtime_retention_removal_recovery_restore_failed');
    }
    sealAndSyncTree(source, parentStat.dev);
    assertSealedRecovery(source, binding.contentHash);
    finalizeStage(recoveryRoot, locations, binding, { referenceSource: source });
    return Object.freeze({ status: 'source_restored' });
  } finally { fs.closeSync(recoveryRoot.descriptor); }
}

export function assertDetachedRetentionRemovalSourceSync({
  binding,
  candidate,
  expectedIdentity,
  stageCapability,
}) {
  verifyRetentionRemovalRecoveryBinding(binding);
  assertRetentionRemovalLiveStageCapabilitySync(stageCapability, binding);
  if (!expectedIdentity
    || hashRecord('RuntimeRetentionMemberIdentity', expectedIdentity)
      !== binding.memberIdentityHash) {
    throw new Error('runtime_retention_detached_recovery_source_invalid');
  }
  const recoveryRoot = openRecoveryRoot(binding, BigInt(binding.memberDevice));
  const locations = stageLocations(recoveryRoot, binding);
  try {
    const resolvedCandidate = path.resolve(String(candidate || ''));
    const allowed = new Set([
      path.join(path.dirname(binding.sourcePath), binding.quarantineName),
      path.join(
        binding.runtimeRoot,
        'retention',
        'removal-recovery',
        locations.stageName,
        'package',
      ),
      path.join(
        binding.runtimeRoot,
        'retention',
        'removal-recovery',
        locations.stageName,
        'rollback',
      ),
    ]);
    if (!allowed.has(resolvedCandidate) || !retentionPathExists(resolvedCandidate)) {
      throw new Error('runtime_retention_detached_recovery_source_invalid');
    }
    const stageIdentity = safeDirectory(locations.stage, recoveryRoot.device);
    verifyRetentionRemovalRecoveryJournal(
      readRegularJsonFileSync(locations.journal),
      binding,
      stageIdentity,
    );
    const mutationMarker = verifyRetentionRemovalMutationMarker(
      readRegularJsonFileSync(locations.mutation),
      binding,
    );
    assertSealedRecovery(locations.rollback, binding.contentHash);
    const rollbackWitness = resolvedCandidate === path.join(
      binding.runtimeRoot,
      'retention',
      'removal-recovery',
      locations.stageName,
      'rollback',
    );
    const observed = rollbackWitness
      ? assertSealedRecovery(resolvedCandidate, binding.contentHash)
      : stableContentHash(resolvedCandidate);
    if (observed.contentHash !== binding.contentHash
      || (!rollbackWitness
        && !bindingIdentityMatches(observed.identity, binding, { allowModeChange: true }))) {
      throw new Error('runtime_retention_detached_recovery_source_invalid');
    }
    assertRetentionRemovalLiveStageCapabilitySync(stageCapability, binding);
    return Object.freeze({ observed, mutationMarker, rollbackWitness });
  } finally { fs.closeSync(recoveryRoot.descriptor); }
}
