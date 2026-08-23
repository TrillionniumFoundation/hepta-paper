import { verifyPackageRetentionRecoveryReceipt }
  from '../paper-domain/automation/package-lifecycle-authority-contract.mjs';
import {
  PACKAGE_RECOVERY_MINIMUM_LIVE_HORIZON_MS,
  packageRecoveryLiveAuthoritySnapshotHash,
  validateTrustedPackageRecoveryLiveSource,
} from './package-recovery-live-source-inspection.mjs';

export {
  PACKAGE_RECOVERY_MINIMUM_LIVE_HORIZON_MS,
  packageRecoveryLiveAuthoritySnapshotHash,
};

export function packageRecoveryVerificationOptions(packageRecoveryAuthority) {
  if (typeof packageRecoveryAuthority?.verifyStorageAuthorityProof !== 'function'
    || typeof packageRecoveryAuthority?.verifyRestoreExecutionProof !== 'function') return null;
  return Object.freeze({
    trustedStorageAuthorityVerifier: (proof, context) =>
      packageRecoveryAuthority.verifyStorageAuthorityProof(proof, context) === true,
    trustedRestoreDrillVerifier: (proof, context) =>
      packageRecoveryAuthority.verifyRestoreExecutionProof(proof, context) === true,
  });
}

export function verifyTrustedPackageRecoveryReceipt({
  packageRecoveryAuthority,
  recoveryReceipt,
  lifecycleReceipt,
} = {}) {
  const verification = packageRecoveryVerificationOptions(packageRecoveryAuthority);
  return Boolean(verification && verifyPackageRetentionRecoveryReceipt(recoveryReceipt, {
    lifecycleReceipt,
    ...verification,
  }).valid);
}

// Migration-only structural validation. This deliberately confers no deletion
// authority; it only prevents a previously trusted v2 row from poisoning
// unrelated lifecycle reconciliation while its external authority is offline.
export function verifyAuditOnlyPackageRecoveryReceipt({
  recoveryReceipt,
  lifecycleReceipt,
} = {}) {
  return Boolean(verifyPackageRetentionRecoveryReceipt(recoveryReceipt, {
    lifecycleReceipt,
    trustedStorageAuthorityVerifier: () => true,
    trustedRestoreDrillVerifier: () => true,
  }).valid);
}

export function inspectTrustedLivePackageRecoverySource({
  packageRecoveryAuthority,
  recoveryReceipt,
  lifecycleReceipt,
  now,
} = {}) {
  if (typeof packageRecoveryAuthority?.inspectLiveRecoverySource !== 'function'
    || !verifyTrustedPackageRecoveryReceipt({
      packageRecoveryAuthority,
      recoveryReceipt,
      lifecycleReceipt,
    })) return null;
  let live;
  try {
    live = packageRecoveryAuthority.inspectLiveRecoverySource({
      recoveryReceipt,
      lifecycleReceipt,
      now,
    });
  } catch { return null; }
  return validateTrustedPackageRecoveryLiveSource({
    live,
    recoveryReceipt,
    lifecycleReceipt,
    now,
  });
}

export function assertPackageRecoveryAuthorityPort(authority) {
  if (authority?.version !== 1
    || authority.kind !== 'PackageRecoveryAuthority'
    || typeof authority.createRecoveryEvidence !== 'function'
    || typeof authority.inspectLiveRecoverySource !== 'function'
    || typeof authority.verifyStorageAuthorityProof !== 'function'
    || typeof authority.verifyRestoreExecutionProof !== 'function') {
    throw new Error('package_recovery_authority_port_invalid');
  }
  return authority;
}
