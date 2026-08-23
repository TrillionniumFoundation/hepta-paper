import path from 'node:path';

import {
  revalidatePackageDeletionAuthorization,
} from './runtime-retention-package-deletion-authority.mjs';

export function packageRemovalDetachedRecoveryEntry({
  authorization,
  expectedContentHash,
  expectedIdentity,
  recoveryBinding,
  recovery,
  sourcePath,
  sourceTreeIdentityHash,
}) {
  return Object.freeze({
    category: 'packages',
    path: authorization.sourcePath,
    name: path.basename(authorization.sourcePath),
    contentHash: expectedContentHash,
    companionPaths: Object.freeze([]),
    sourcePath,
    identity: expectedIdentity,
    packageRecoveryTreeInventoryHash:
      authorization.retentionDeletionEvidence?.packageRecoveryTreeInventoryHash || null,
    recoveryBinding,
    recoveryStageCapability: recovery.stageCapability,
    sourceTreeIdentityHash,
  });
}

export function createPackageRemovalIrreversibleBoundary({
  authorization,
  expectedContentHash,
  expectedIdentity,
  recoveryBinding,
  recovery,
  sourceTreeIdentityHash,
  revalidateAuthorization,
  assertFencedGenerationLock,
  assertLiveLocks,
  withDeletionFenceGuard = (operation) => operation(),
  markRemovalStarted,
  faultInjector = null,
}) {
  const rollbackEntry = packageRemovalDetachedRecoveryEntry({
    authorization,
    expectedContentHash,
    expectedIdentity,
    recoveryBinding,
    recovery,
    sourcePath: path.join(
      recoveryBinding.runtimeRoot,
      'retention',
      'removal-recovery',
      recovery.locations.stageName,
      'rollback',
    ),
    sourceTreeIdentityHash,
  });
  let validated = false;
  let started = false;
  let irreversibleStep = 0;
  const revalidate = (stage) => revalidatePackageDeletionAuthorization({
    authorization,
    expectedContentHash,
    revalidateAuthorization,
    stage,
    detachedRetentionEntries: [rollbackEntry],
  });
  return Object.freeze({
    commit(operation) {
      if (typeof operation !== 'function') {
        throw new Error('runtime_retention_package_removal_operation_invalid');
      }
      return withDeletionFenceGuard(() => {
        validated = false;
        recovery.assertLiveStage();
        assertFencedGenerationLock();
        assertLiveLocks();
        if (!started) {
          faultInjector?.({ stage: 'before_package_tree_first_unlink_revalidation' });
        }
        faultInjector?.({
          stage: 'before_package_tree_unlink_revalidation',
          irreversibleStep,
        });
        revalidate('before_package_tree_unlink');
        faultInjector?.({
          stage: 'after_package_tree_unlink_revalidation',
          irreversibleStep,
        });
        revalidate('before_package_tree_unlink_commit');
        assertLiveLocks();
        assertFencedGenerationLock();
        recovery.assertLiveStage();
        validated = true;
        if (!validated) {
          throw new Error('runtime_retention_package_removal_live_authority_changed');
        }
        validated = false;
        if (!started) {
          markRemovalStarted();
          started = true;
        }
        const result = operation();
        if (result && typeof result.then === 'function') {
          throw new Error('runtime_retention_package_removal_async_operation_forbidden');
        }
        irreversibleStep += 1;
        faultInjector?.({
          stage: 'after_package_tree_irreversible_step',
          irreversibleStep,
        });
        return result;
      });
    },
  });
}
