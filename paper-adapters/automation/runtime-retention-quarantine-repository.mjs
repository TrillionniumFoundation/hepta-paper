import fs from 'node:fs';
import path from 'node:path';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  openPinnedRetentionCategory,
  pinnedRetentionMemberPath,
  retentionMemberHash,
  retentionMemberIdentity,
  retentionPathExists,
} from './runtime-retention-scope-repository.mjs';
import {
  withRuntimeRetentionCategoryLock,
} from './runtime-retention-category-lock-repository.mjs';
import {
  removeAuthorizedSealedPackageTreeSync,
} from './runtime-retention-authorized-package-removal.mjs';
import {
  retentionRemovalRecoveryBindingForIntent,
} from './runtime-retention-removal-recovery-contract.mjs';
import {
  finalizeRetentionRemovalRecoverySync,
  prepareRetentionRemovalRecoverySync,
  recoverRetentionRemovalSync,
} from './runtime-retention-removal-recovery-repository.mjs';
import {
  unsealRetentionRemovalCandidateSync,
} from './runtime-retention-removal-snapshot-repository.mjs';
import {
  removeRetentionRemovalCandidateSync,
} from './runtime-retention-pinned-removal-repository.mjs';
import {
  withTrustedRetentionTombstoneCapability,
} from './runtime-retention-trusted-receipt-repository.mjs';
import {
  withPublishedPackageDeletionLeaseSync,
} from './runtime-retention-published-package-deletion-lease.mjs';
import { inspectPackageRecoveryTreeInventorySync }
  from './package-recovery-tree-inventory-repository.mjs';

const QUARANTINE_NAME = /^\.hepta-retention-[a-f0-9]{40}\.quarantine$/;
const STABLE_IDENTITY_FIELDS = Object.freeze([
  'dev', 'ino', 'mode', 'size', 'mtimeNs', 'nlink', 'entryKind',
]);

function quarantineName(operationId, memberPath, index) {
  const digest = hashRecord('RuntimeRetentionQuarantineMember', {
    operationId,
    memberPath: path.resolve(memberPath),
    index,
  }).slice(7, 47);
  return `.hepta-retention-${digest}.quarantine`;
}

function sameStableIdentity(left, right) {
  return Boolean(left && right && STABLE_IDENTITY_FIELDS.every((field) =>
    String(left[field]) === String(right[field])));
}

function inspectStableMember(candidate) {
  if (!retentionPathExists(candidate)) {
    return Object.freeze({ exists: false, contentHash: null, identity: null });
  }
  const before = retentionMemberIdentity(candidate);
  const firstHash = retentionMemberHash(candidate);
  const secondHash = retentionMemberHash(candidate);
  const after = retentionMemberIdentity(candidate);
  if (!sameStableIdentity(before, after)
    || before.realPath !== after.realPath
    || firstHash !== secondHash) {
    throw new Error('runtime_retention_member_changed_during_inspection');
  }
  return Object.freeze({ exists: true, contentHash: firstHash, identity: before });
}

function assertExpectedMember(observed, member, expectedRealPath) {
  if (!observed.exists
    || observed.contentHash !== member.contentHash
    || !sameStableIdentity(observed.identity, member.identity)
    || path.resolve(observed.identity.realPath) !== path.resolve(expectedRealPath)) {
    throw new Error('runtime_retention_member_preimage_changed');
  }
}

function assertLiveCategoryScope(intent, entry) {
  const live = openPinnedRetentionCategory(
    intent.runtimeRoot,
    entry.category,
    entry.categoryScope,
  );
  live.close();
}

function memberPaths(pinned, runtimeRoot, category, member) {
  if (!QUARANTINE_NAME.test(String(member.quarantineName || ''))) {
    throw new Error('runtime_retention_quarantine_name_invalid');
  }
  return Object.freeze({
    source: pinnedRetentionMemberPath(
      pinned,
      runtimeRoot,
      category,
      member.path,
    ),
    quarantine: path.join(pinned.categoryDescriptorPath, member.quarantineName),
    sourceRealPath: path.resolve(member.identity?.realPath || ''),
    quarantineRealPath: path.join(
      path.resolve(pinned.scope.categoryRoot.realPath),
      member.quarantineName,
    ),
  });
}

function revalidateQuarantinedAuthority({
  intent,
  entry,
  entryIndex,
  pinned,
  revalidateAuthority,
  detachedRetentionEntries = [],
}) {
  if (typeof revalidateAuthority !== 'function') return null;
  if (detachedRetentionEntries.length) {
    return revalidateAuthority({
      intent,
      entry,
      entryIndex,
      detachedRetentionEntries,
    });
  }
  const restored = [];
  for (let memberIndex = 0; memberIndex < entry.members.length; memberIndex += 1) {
    const member = entry.members[memberIndex];
    const locations = memberPaths(pinned, intent.runtimeRoot, entry.category, member);
    const source = inspectStableMember(locations.source);
    const quarantined = inspectStableMember(locations.quarantine);
    if (source.exists && quarantined.exists) {
      throw new Error('runtime_retention_quarantine_source_collision');
    }
    if (!quarantined.exists) continue;
    assertExpectedMember(quarantined, member, locations.quarantineRealPath);
    fs.renameSync(locations.quarantine, locations.source);
    fs.fsyncSync(pinned.categoryDescriptor);
    assertExpectedMember(inspectStableMember(locations.source), member, locations.sourceRealPath);
    restored.push({ member, memberIndex, locations });
  }
  const liveAuthority = revalidateAuthority({ intent, entry, entryIndex });
  for (const { member, locations } of restored) {
    if (inspectStableMember(locations.quarantine).exists) {
      throw new Error('runtime_retention_quarantine_source_collision');
    }
    assertExpectedMember(inspectStableMember(locations.source), member, locations.sourceRealPath);
    fs.renameSync(locations.source, locations.quarantine);
    fs.fsyncSync(pinned.categoryDescriptor);
    assertExpectedMember(
      inspectStableMember(locations.quarantine),
      member,
      locations.quarantineRealPath,
    );
  }
  return liveAuthority;
}

export function bindRetentionQuarantineMembers(entries, operationId) {
  return entries.map((entry, entryIndex) => ({
    ...entry,
    members: entry.members.map((member, memberIndex) => ({
      ...member,
      quarantineName: quarantineName(
        operationId,
        member.path,
        entryIndex * 1000 + memberIndex,
      ),
    })),
  }));
}

export function verifyRetentionQuarantineMemberBinding(
  operationId,
  member,
  entryIndex,
  memberIndex,
) {
  const expectedName = quarantineName(
    operationId,
    member?.path,
    entryIndex * 1000 + memberIndex,
  );
  return Boolean(member?.identity
    && STABLE_IDENTITY_FIELDS.every((field) =>
      typeof member.identity[field] === 'string' && member.identity[field].length > 0)
    && typeof member.identity.realPath === 'string'
    && path.isAbsolute(member.identity.realPath)
    && member.quarantineName === expectedName);
}

export function restoreRetentionQuarantines(intent, {
  faultInjector = null,
  skipRecoveryBindingHashes = [],
  exactRestoredRecoveryBindingHashes = [],
} = {}) {
  const skipped = new Set(skipRecoveryBindingHashes);
  const exactRestored = new Set(exactRestoredRecoveryBindingHashes);
  for (let entryIndex = 0; entryIndex < intent.entries.length; entryIndex += 1) {
    const entry = intent.entries[entryIndex];
    if (!entry.authorized) continue;
    const pinned = openPinnedRetentionCategory(
      intent.runtimeRoot,
      entry.category,
      entry.categoryScope,
    );
    const restoreEntry = (categoryLock = null) => {
      const assertLocked = () => categoryLock?.assertHeld();
      assertLocked();
      assertLiveCategoryScope(intent, entry);
      for (let memberIndex = 0; memberIndex < entry.members.length; memberIndex += 1) {
        const member = entry.members[memberIndex];
        const locations = memberPaths(pinned, intent.runtimeRoot, entry.category, member);
        let removalRecovery = null;
        if (member.identity?.entryKind === 'directory') {
          const recoveryBinding = retentionRemovalRecoveryBindingForIntent(
            intent, entry, entryIndex, member, memberIndex,
          );
          const bindingHash = hashRecord(
            'RuntimeRetentionRemovalRecoveryBinding',
            recoveryBinding,
          );
          if (skipped.has(bindingHash)) {
            if (retentionPathExists(locations.source)
              || retentionPathExists(locations.quarantine)) {
              throw new Error('runtime_retention_package_deletion_postimage_invalid');
            }
            continue;
          }
          if (exactRestored.has(bindingHash)) {
            if (entry.category !== 'packages'
              || entry.retentionDeletionEvidence?.evidenceKind
                !== 'package_superseded_recovery_verified'
              || !retentionPathExists(locations.source)
              || retentionPathExists(locations.quarantine)
              || inspectPackageRecoveryTreeInventorySync({
                packagePath: member.path,
              }).inventory.packageRecoveryTreeInventoryHash
                !== entry.retentionDeletionEvidence.packageRecoveryTreeInventoryHash) {
              throw new Error('runtime_retention_package_deletion_rollback_inventory_changed');
            }
            continue;
          }
          removalRecovery = recoverRetentionRemovalSync({
            binding: recoveryBinding,
            parentDescriptor: pinned.categoryDescriptor,
            parentDescriptorPath: pinned.categoryDescriptorPath,
          });
        }
        if (removalRecovery?.status === 'source_restored') {
          continue;
        }
        const source = inspectStableMember(locations.source);
        const quarantined = inspectStableMember(locations.quarantine);
        if (source.exists && quarantined.exists) {
          throw new Error('runtime_retention_quarantine_source_collision');
        }
        if (quarantined.exists) {
          assertExpectedMember(quarantined, member, locations.quarantineRealPath);
          if (source.exists) throw new Error('runtime_retention_quarantine_source_collision');
          faultInjector?.({
            stage: 'before_member_quarantine_restore', intent, entry, entryIndex,
            member, memberIndex,
          });
          assertLocked();
          assertLiveCategoryScope(intent, entry);
          fs.renameSync(locations.quarantine, locations.source);
          fs.fsyncSync(pinned.categoryDescriptor);
          assertExpectedMember(
            inspectStableMember(locations.source),
            member,
            locations.sourceRealPath,
          );
          if (retentionPathExists(locations.quarantine)) {
            throw new Error('runtime_retention_quarantine_restore_postimage_invalid');
          }
          faultInjector?.({
            stage: 'after_member_quarantine_restored', intent, entry, entryIndex,
            member, memberIndex,
          });
        } else if (source.exists) {
          assertExpectedMember(source, member, locations.sourceRealPath);
        }
      }
      assertLocked();
      assertLiveCategoryScope(intent, entry);
    };
    try {
      withRuntimeRetentionCategoryLock(pinned, entry.category, restoreEntry);
    } finally {
      pinned.close();
    }
  }
}

export function finalizeRetentionRemovalRecoveries(
  intent,
  { tombstone, retentionReceiptLedger } = {},
) {
  return withTrustedRetentionTombstoneCapability({
    retentionReceiptLedger,
    intent,
    tombstone,
    operation: (capability) => {
      for (let entryIndex = 0; entryIndex < intent.entries.length; entryIndex += 1) {
        const entry = intent.entries[entryIndex];
        if (!entry.authorized) continue;
        for (let memberIndex = 0; memberIndex < entry.members.length; memberIndex += 1) {
          const member = entry.members[memberIndex];
          if (member.identity?.entryKind !== 'directory') continue;
          finalizeRetentionRemovalRecoverySync(retentionRemovalRecoveryBindingForIntent(
            intent, entry, entryIndex, member, memberIndex,
          ), capability);
        }
      }
    },
  });
}

export function removeRetentionEntryThroughQuarantine(
  intent,
  entry,
  entryIndex,
  pinned,
  {
    faultInjector = null,
    revalidateAuthority = null,
    validateQuarantinedState = null,
    validateRemovedState = null,
    assertCategoryLock = null,
    packageRecoveryDeletionLeasePort = null,
  } = {},
) {
  const assertLocked = () => {
    if (typeof assertCategoryLock === 'function') assertCategoryLock();
  };
  const restoreQuarantinedMembers = (quarantinedMembers) => {
    for (const { member, locations } of [...quarantinedMembers].reverse()) {
      const source = inspectStableMember(locations.source);
      const quarantined = inspectStableMember(locations.quarantine);
      if (source.exists || !quarantined.exists) continue;
      assertExpectedMember(quarantined, member, locations.quarantineRealPath);
      assertLocked();
      fs.renameSync(locations.quarantine, locations.source);
      fs.fsyncSync(pinned.categoryDescriptor);
      assertExpectedMember(
        inspectStableMember(locations.source),
        member,
        locations.sourceRealPath,
      );
    }
  };
  const validateQuarantinedOrRestore = (quarantinedMembers) => {
    if (!quarantinedMembers.length || typeof validateQuarantinedState !== 'function') return;
    try {
      assertLocked();
      validateQuarantinedState({ intent, entry, entryIndex, pinned });
      assertLocked();
    } catch (error) {
      restoreQuarantinedMembers(quarantinedMembers);
      throw error;
    }
  };
  assertLocked();
  const quarantinedMembers = [];
  const recoveryBindings = [];
  let alreadyAbsent = true;
  for (let memberIndex = 0; memberIndex < entry.members.length; memberIndex += 1) {
    const member = entry.members[memberIndex];
    const locations = memberPaths(pinned, intent.runtimeRoot, entry.category, member);
    let source = inspectStableMember(locations.source);
    let quarantined = inspectStableMember(locations.quarantine);
    if (source.exists && quarantined.exists) {
      throw new Error('runtime_retention_quarantine_source_collision');
    }
    if (!source.exists && !quarantined.exists) continue;
    alreadyAbsent = false;
    if (source.exists) {
      assertExpectedMember(source, member, locations.sourceRealPath);
      faultInjector?.({
        stage: 'before_member_quarantined', intent, entry, entryIndex,
        member, memberIndex,
      });
      revalidateQuarantinedAuthority({
        intent, entry, entryIndex, pinned, revalidateAuthority,
      });
      assertLocked();
      assertLiveCategoryScope(intent, entry);
      fs.renameSync(locations.source, locations.quarantine);
      fs.fsyncSync(pinned.categoryDescriptor);
      quarantined = inspectStableMember(locations.quarantine);
      assertExpectedMember(quarantined, member, locations.quarantineRealPath);
      source = inspectStableMember(locations.source);
      if (source.exists) throw new Error('runtime_retention_quarantine_source_advanced');
      faultInjector?.({
        stage: 'after_member_quarantined', intent, entry, entryIndex,
        member, memberIndex,
      });
    } else {
      assertExpectedMember(quarantined, member, locations.quarantineRealPath);
    }
    quarantinedMembers.push({ member, memberIndex, locations });
  }
  validateQuarantinedOrRestore(quarantinedMembers);
  faultInjector?.({ stage: 'after_entry_quarantined', intent, entry, entryIndex });
  if (quarantinedMembers.length) {
    revalidateQuarantinedAuthority({
      intent, entry, entryIndex, pinned, revalidateAuthority,
    });
    assertLocked();
  }
  for (const { member, memberIndex } of quarantinedMembers) {
    faultInjector?.({
      stage: 'before_quarantined_member_removed', intent, entry, entryIndex,
      member, memberIndex,
    });
    revalidateQuarantinedAuthority({
      intent, entry, entryIndex, pinned, revalidateAuthority,
    });
  }
  // Recheck immediately before the first irreversible removal. This closes the
  // interval opened by fault hooks and live-authority restoration/requarantine.
  validateQuarantinedOrRestore(quarantinedMembers);
  for (const { member, memberIndex, locations } of quarantinedMembers) {
    if (inspectStableMember(locations.source).exists) {
      throw new Error('runtime_retention_quarantine_source_advanced');
    }
    assertExpectedMember(
      inspectStableMember(locations.quarantine),
      member,
      locations.quarantineRealPath,
    );
    assertLocked();
    assertLiveCategoryScope(intent, entry);
    if (inspectStableMember(locations.source).exists) {
      throw new Error('runtime_retention_quarantine_source_advanced');
    }
    assertExpectedMember(
      inspectStableMember(locations.quarantine),
      member,
      locations.quarantineRealPath,
    );
    if (entry.category === 'packages') {
      const fencedStaging = entry.retentionDeletionEvidence?.evidenceKind
        === 'package_fenced_staging_generation_verified';
      if (member.identity?.entryKind !== 'directory'
        || (fencedStaging
          ? (Number(member.identity.mode) & 0o200) === 0
          : (Number(member.identity.mode) & 0o222) !== 0)) {
        restoreQuarantinedMembers([{ member, locations }]);
        throw new Error('runtime_retention_package_removal_tree_not_sealed');
      }
      try {
        // The destructive package remover must operate on the exact canonical
        // path named by the live reachability evidence. Restore the pinned
        // quarantine inode first so an authorization for one package cannot
        // be confused with an identical sibling or an out-of-scope clone.
        fs.renameSync(locations.quarantine, locations.source);
        fs.fsyncSync(pinned.categoryDescriptor);
        assertExpectedMember(
          inspectStableMember(locations.source),
          member,
          locations.sourceRealPath,
        );
        const recoveryBinding = retentionRemovalRecoveryBindingForIntent(
          intent, entry, entryIndex, member, memberIndex,
        );
        const deletion = withPublishedPackageDeletionLeaseSync({
          intent,
          entry,
          member,
          recoveryBinding,
          packageRecoveryDeletionLeasePort,
          faultInjector: ({ stage, ...details }) => faultInjector?.({
            stage, ...details, intent, entry, entryIndex, member, memberIndex,
          }),
          operation: ({
            assertDeletionLease,
            withDeletionFenceGuard,
          }) => removeAuthorizedSealedPackageTreeSync({
            candidate: locations.source,
            expectedContentHash: member.contentHash,
            expectedIdentity: member.identity,
            authorization: {
              authorized: entry.authorized,
              category: entry.category,
              sourcePath: member.path,
              retentionDeletionEvidence: entry.retentionDeletionEvidence,
            },
            revalidateAuthorization: ({ detachedRetentionEntries = [] } = {}) =>
              revalidateQuarantinedAuthority({
                intent,
                entry,
                entryIndex,
                pinned,
                revalidateAuthority,
                detachedRetentionEntries,
              }),
            recoveryBinding,
            assertLiveLocks: () => {
              assertLocked();
              assertLiveCategoryScope(intent, entry);
            },
            assertExternalDeletionLease: assertDeletionLease,
            withDeletionFenceGuard,
            faultInjector: ({ stage, ...details }) => faultInjector?.({
              stage,
              ...details,
              intent,
              entry,
              entryIndex,
              member,
              memberIndex,
            }),
          }),
        });
        const removal = deletion.result;
        recoveryBindings.push(removal.recoveryBinding);
      } catch (error) {
        restoreQuarantinedMembers([{ member, locations }]);
        throw error;
      }
    } else if (member.identity?.entryKind === 'directory') {
      const recoveryBinding = retentionRemovalRecoveryBindingForIntent(
        intent, entry, entryIndex, member, memberIndex,
      );
      const recovery = prepareRetentionRemovalRecoverySync({
        candidate: locations.quarantine,
        binding: recoveryBinding,
        expectedIdentity: member.identity,
      });
      try {
        recovery.beginMutation();
        unsealRetentionRemovalCandidateSync({
          candidate: locations.quarantine,
          binding: recoveryBinding,
          expectedIdentity: member.identity,
        });
        assertLocked();
        assertLiveCategoryScope(intent, entry);
        removeRetentionRemovalCandidateSync({
          candidate: locations.quarantine,
          binding: recoveryBinding,
          expectedIdentity: member.identity,
          beforeFirstIrreversible: () => {
            recovery.assertLiveStage();
            assertLocked();
            assertLiveCategoryScope(intent, entry);
            const live = revalidateQuarantinedAuthority({
              intent,
              entry,
              entryIndex,
              pinned,
              revalidateAuthority,
              detachedRetentionEntries: [Object.freeze({
                category: entry.category,
                path: entry.path,
                name: path.basename(entry.path),
                contentHash: entry.contentHash,
                companionPaths: entry.companionPaths,
                sourcePath: path.join(
                  path.dirname(member.path),
                  member.quarantineName,
                ),
                identity: member.identity,
                recoveryBinding,
                recoveryStageCapability: recovery.stageCapability,
                sourceTreeIdentityHash: null,
              })],
            });
            assertLocked();
            assertLiveCategoryScope(intent, entry);
            recovery.assertLiveStage();
            return live;
          },
        });
        recoveryBindings.push(recoveryBinding);
      } catch (error) {
        try {
          recoverRetentionRemovalSync({
            binding: recoveryBinding,
            parentDescriptor: pinned.categoryDescriptor,
            parentDescriptorPath: pinned.categoryDescriptorPath,
          });
        } catch (recoveryError) {
          throw new AggregateError(
            [error, recoveryError],
            'runtime_retention_removal_failed_and_recovery_failed',
          );
        }
        throw error;
      } finally {
        recovery.close();
      }
    } else {
      fs.rmSync(locations.quarantine, { recursive: false, force: false });
    }
    fs.fsyncSync(pinned.categoryDescriptor);
    if (retentionPathExists(locations.source)
      || retentionPathExists(locations.quarantine)) {
      throw new Error('runtime_retention_quarantine_removal_postimage_invalid');
    }
    faultInjector?.({
      stage: 'after_member_removed', intent, entry, entryIndex,
      member, memberIndex,
    });
  }
  if (typeof validateRemovedState === 'function') {
    assertLocked();
    validateRemovedState({ intent, entry, entryIndex, pinned });
    assertLocked();
  }
  return Object.freeze({
    alreadyAbsent,
    recoveryBindings: Object.freeze(recoveryBindings),
  });
}
