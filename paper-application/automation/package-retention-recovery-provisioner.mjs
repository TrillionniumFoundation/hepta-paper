import {
  createPackageReleaseIdentity,
  createPackageRetentionRecoveryReceipt,
} from '../../paper-domain/automation/package-lifecycle-authority-contract.mjs';
import {
  assertPackageRecoveryAuthorityPort,
  inspectTrustedLivePackageRecoverySource,
  packageRecoveryVerificationOptions,
  verifyTrustedPackageRecoveryReceipt,
} from '../../paper-ports/package-recovery-authority-port.mjs';
import { hasExactPlainObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';

const SHA256 = /^sha256:[a-f0-9]{64}$/;

function exactEvidence(value) {
  return hasExactPlainObjectKeys(
    value,
    ['recoverySourceAuthority', 'restoreDrillReceipt'],
  );
}

function sameInspectedPackage(left, right) {
  return Boolean(left && right
    && left.packagePath === right.packagePath
    && left.packageContentHash === right.packageContentHash
    && left.packageRecoveryTreeInventoryHash
      === right.packageRecoveryTreeInventoryHash
    && left.immutableCampaignPackageOutputHash
      === right.immutableCampaignPackageOutputHash
    && JSON.stringify(left.packageDirectoryIdentity)
      === JSON.stringify(right.packageDirectoryIdentity));
}

function assertRecoveryLockRepository(repository) {
  if (repository?.version !== 1
    || repository.kind !== 'PackageRetentionRecoveryLockRepository'
    || typeof repository.withLifecycleLock !== 'function') {
    throw new Error('package_retention_recovery_lock_repository_invalid');
  }
  return repository;
}

function provisionLocked({
  authority,
  campaignReleaseQuery,
  clock,
  lifecycleLock,
  loadLifecycleRows,
  materializationInspector,
  packageLifecycleReceiptHash,
  parseReceipt,
  recordRecoveryReceipt,
}) {
  lifecycleLock.assertHeld();
  let lifecycleRows = loadLifecycleRows();
  const lifecycleMatches = lifecycleRows.map(parseReceipt)
    .filter((receipt) => receipt?.kind === 'PackageLifecycleReceipt'
      && receipt.packageLifecycleReceiptHash === packageLifecycleReceiptHash);
  if (lifecycleMatches.length !== 1) {
    throw new Error('package_retention_recovery_lifecycle_not_unique');
  }
  const lifecycleReceipt = lifecycleMatches[0];
  const existing = lifecycleRows.map(parseReceipt)
    .filter((receipt) => receipt?.kind === 'PackageRetentionRecoveryReceipt'
      && receipt.packageLifecycleReceiptHash === packageLifecycleReceiptHash);
  lifecycleLock.assertHeld();
  if (existing.length > 1) {
    throw new Error('package_retention_recovery_receipt_ambiguous');
  }
  if (existing.length === 1) {
    if (!inspectTrustedLivePackageRecoverySource({
      packageRecoveryAuthority: authority,
      recoveryReceipt: existing[0],
      lifecycleReceipt,
      now: clock.nowIso(),
    })) throw new Error('package_retention_recovery_source_not_live');
    lifecycleLock.assertHeld();
    return Object.freeze({
      status: 'package_retention_recovery_already_recorded',
      packageLifecycleReceiptHash,
      packageRetentionRecoveryReceiptHash:
        existing[0].packageRetentionRecoveryReceiptHash,
      externalActionPerformed: false,
    });
  }

  const release = campaignReleaseQuery.getCurrentRelease({
    campaignId: lifecycleReceipt.releaseIdentity.campaignId,
  });
  let releaseIdentity;
  try { releaseIdentity = createPackageReleaseIdentity(release); } catch {
    throw new Error('package_retention_recovery_release_unavailable');
  }
  if (releaseIdentity.packageReleaseIdentityHash
    !== lifecycleReceipt.packageReleaseIdentityHash) {
    throw new Error('package_retention_recovery_release_identity_mismatch');
  }
  const before = materializationInspector.inspectRelease({
    releaseBundle: release.releaseBundle,
  });
  if (before.packagePath !== lifecycleReceipt.packagePath
    || before.packageContentHash !== lifecycleReceipt.packageContentHash
    || before.packageRecoveryTreeInventoryHash
      !== lifecycleReceipt.packageRecoveryTreeInventoryHash
    || before.immutableCampaignPackageOutputHash
      !== lifecycleReceipt.releaseIdentity.immutableCampaignPackageOutputHash) {
    throw new Error('package_retention_recovery_preimage_mismatch');
  }
  lifecycleLock.assertHeld();
  const recoveryRequestedAt = clock.nowIso();
  const evidence = authority.createRecoveryEvidence({
    lifecycleReceipt,
    inspectedPackage: before,
    recordedAt: recoveryRequestedAt,
  });
  if (!exactEvidence(evidence) || evidence?.then) {
    throw new Error('package_retention_recovery_evidence_invalid');
  }
  lifecycleLock.assertHeld();
  const recordedAt = clock.nowIso();
  const recoveryReceipt = createPackageRetentionRecoveryReceipt({
    lifecycleReceipt,
    recoverySourceAuthority: evidence.recoverySourceAuthority,
    restoreDrillReceipt: evidence.restoreDrillReceipt,
    recordedAt,
    ...packageRecoveryVerificationOptions(authority),
  });
  const after = materializationInspector.inspectRelease({
    releaseBundle: release.releaseBundle,
  });
  if (!sameInspectedPackage(before, after)
    || !verifyTrustedPackageRecoveryReceipt({
      packageRecoveryAuthority: authority,
      recoveryReceipt,
      lifecycleReceipt,
    })
    || !inspectTrustedLivePackageRecoverySource({
      packageRecoveryAuthority: authority,
      recoveryReceipt,
      lifecycleReceipt,
      now: clock.nowIso(),
    })) {
    throw new Error('package_retention_recovery_evidence_not_trusted');
  }
  lifecycleLock.assertHeld();
  recordRecoveryReceipt(recoveryReceipt, lifecycleReceipt.releaseIdentity.paperId);
  lifecycleLock.assertHeld();
  lifecycleRows = loadLifecycleRows();
  const persisted = lifecycleRows.map(parseReceipt)
    .filter((receipt) => receipt?.kind === 'PackageRetentionRecoveryReceipt'
      && receipt.packageLifecycleReceiptHash === packageLifecycleReceiptHash);
  if (persisted.length !== 1
    || persisted[0].packageRetentionRecoveryReceiptHash
      !== recoveryReceipt.packageRetentionRecoveryReceiptHash) {
    throw new Error('package_retention_recovery_persist_conflict');
  }
  lifecycleLock.assertHeld();
  return Object.freeze({
    status: 'package_retention_recovery_recorded',
    packageLifecycleReceiptHash,
    packageRetentionRecoveryReceiptHash:
      recoveryReceipt.packageRetentionRecoveryReceiptHash,
    externalActionPerformed: true,
  });
}

export function createPackageRetentionRecoveryProvisioner({
  campaignReleaseQuery,
  materializationInspector,
  packageRecoveryAuthority,
  packageRetentionRecoveryLockRepository,
  loadLifecycleRows,
  parseReceipt,
  recordRecoveryReceipt,
  clock,
} = {}) {
  const authority = packageRecoveryAuthority
    ? assertPackageRecoveryAuthorityPort(packageRecoveryAuthority) : null;
  const recoveryLockRepository = authority
    ? assertRecoveryLockRepository(packageRetentionRecoveryLockRepository) : null;

  return function provisionRetentionRecovery({ packageLifecycleReceiptHash } = {}) {
    if (typeof packageLifecycleReceiptHash !== 'string'
      || !SHA256.test(packageLifecycleReceiptHash) || !authority) {
      throw new Error('package_retention_recovery_authority_unavailable');
    }
    return recoveryLockRepository.withLifecycleLock(
      packageLifecycleReceiptHash,
      (lifecycleLock) => provisionLocked({
        authority,
        campaignReleaseQuery,
        clock,
        lifecycleLock,
        loadLifecycleRows,
        materializationInspector,
        packageLifecycleReceiptHash,
        parseReceipt,
        recordRecoveryReceipt,
      }),
    );
  };
}
