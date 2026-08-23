import { hasExactPlainObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { verifyPackageLifecycleReceipt } from './package-lifecycle-receipt-contract.mjs';

export {
  createPackageLifecycleReceipt,
  createPackageReleaseIdentity,
  verifyPackageLifecycleReceipt,
  verifyPackageReleaseIdentity,
} from './package-lifecycle-receipt-contract.mjs';

export {
  createPackageExactRestoreDrillReceipt,
  createPackageExactRestoreExecutionProof,
  createPackageImmutableRecoverySourceAuthority,
  createPackageRecoveryRetentionPolicy,
  createPackageRecoveryStorageAuthorityProof,
  createPackageRetentionRecoveryReceipt,
  packageRecoveryStorageAuthoritySubjectHash,
  verifyPackageExactRestoreDrillReceipt,
  verifyPackageExactRestoreExecutionProof,
  verifyPackageImmutableRecoverySourceAuthority,
  verifyPackageRecoveryRetentionPolicy,
  verifyPackageRecoveryStorageAuthorityProof,
  verifyPackageRetentionRecoveryReceipt,
} from './package-retention-recovery-authority-contract.mjs';

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const LINEAGE_KINDS = new Set(['supersedes', 'recovery']);

const LEGACY_RECOVERY_KEYS = Object.freeze([
  'version', 'kind', 'status', 'recoveryMode', 'predecessorPackageContentHash',
  'successorPackageContentHash', 'successorLifecycleReceiptHash',
  'successorReleaseIdentityHash', 'successorPackagePresent',
  'successorPackageHashVerified', 'successorReleaseCurrent',
  'restoreSourceAvailable', 'productionPackageMutated', 'externalActionPerformed',
  'verifiedAt', 'packageRecoveryVerificationHash',
]);

const REFERENCE_KEYS = Object.freeze([
  'version', 'kind', 'status', 'inventoryComplete', 'campaignInventoryHash',
  'currentReleaseInventoryHash', 'casManifestInventoryHash',
  'receiptLedgerInventoryHash', 'activeReferenceCampaignIds',
  'recoveryReferenceCampaignIds', 'legalHoldReceiptHashes',
  'casReferenceManifestHashes', 'scannedAt', 'packageRetentionReferenceSnapshotHash',
]);

const SUPERSESSION_KEYS = Object.freeze([
  'version', 'kind', 'status', 'runtimeRoot', 'paperId', 'lineageKind',
  'predecessorLifecycleReceiptHash', 'successorLifecycleReceiptHash',
  'predecessorReleaseIdentityHash', 'successorReleaseIdentityHash',
  'predecessorPackagePath', 'predecessorPackageContentHash',
  'successorPackagePath', 'successorPackageContentHash',
  'successorIsExactPredecessorCopy', 'successorAuthorizesPredecessorDeletion',
  'referenceSnapshot', 'packageRetentionReferenceSnapshotHash', 'recordedAt',
  'externalActionPerformed', 'packageSupersessionReceiptHash',
]);

const LEGACY_SUPERSESSION_KEYS = Object.freeze([
  'version', 'kind', 'status', 'runtimeRoot', 'paperId', 'lineageKind',
  'predecessorLifecycleReceiptHash', 'successorLifecycleReceiptHash',
  'predecessorReleaseIdentityHash', 'successorReleaseIdentityHash',
  'predecessorPackagePath', 'predecessorPackageContentHash',
  'successorPackagePath', 'successorPackageContentHash', 'recoveryVerification',
  'packageRecoveryVerificationHash', 'referenceSnapshot',
  'packageRetentionReferenceSnapshotHash', 'recordedAt',
  'externalActionPerformed', 'packageSupersessionReceiptHash',
]);

const HOLD_KEYS = Object.freeze([
  'version', 'kind', 'status', 'runtimeRoot', 'paperId', 'packagePath',
  'packageContentHash', 'packageLifecycleReceiptHash', 'reasonHash', 'createdAt',
  'externalActionPerformed', 'packageRetentionLegalHoldReceiptHash',
]);

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validHash(value) {
  return typeof value === 'string' && SHA256.test(value);
}

function validTime(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function canonicalTime(value) {
  return validTime(value) && new Date(Date.parse(value)).toISOString() === value;
}

function atOrAfter(value, lowerBound) {
  return validTime(value) && validTime(lowerBound)
    && Date.parse(value) >= Date.parse(lowerBound);
}

function strictlyAfter(value, lowerBound) {
  return canonicalTime(value) && validTime(lowerBound)
    && Date.parse(value) > Date.parse(lowerBound);
}

function canonicalAbsolutePath(value) {
  return nonEmpty(value)
    && value.startsWith('/')
    && value !== '/'
    && !value.includes('\0')
    && !value.includes('//')
    && !value.endsWith('/')
    && !value.split('/').some((component) => component === '.' || component === '..');
}

function exactKeys(value, keys) {
  return hasExactPlainObjectKeys(value, [...keys].sort());
}

function result(blockers, details = {}) {
  return Object.freeze({
    valid: blockers.length === 0,
    ...details,
    blockers: Object.freeze([...new Set(blockers)]),
  });
}

function verifyLegacyRecoveryVerification(value, predecessor = null, successor = null) {
  const { packageRecoveryVerificationHash = null, ...payload } = value || {};
  return Boolean(exactKeys(value, LEGACY_RECOVERY_KEYS)
    && value.version === 1
    && value.kind === 'PackageRecoveryVerification'
    && value.status === 'successor_package_recovery_verified'
    && value.recoveryMode === 'current_successor_package_materialization'
    && (!predecessor
      || value.predecessorPackageContentHash === predecessor.packageContentHash)
    && (!successor || (value.successorPackageContentHash === successor.packageContentHash
      && value.successorLifecycleReceiptHash === successor.packageLifecycleReceiptHash
      && value.successorReleaseIdentityHash === successor.packageReleaseIdentityHash))
    && validHash(value.predecessorPackageContentHash)
    && validHash(value.successorPackageContentHash)
    && validHash(value.successorLifecycleReceiptHash)
    && validHash(value.successorReleaseIdentityHash)
    && value.successorPackagePresent === true
    && value.successorPackageHashVerified === true
    && value.successorReleaseCurrent === true
    && value.restoreSourceAvailable === true
    && value.productionPackageMutated === false
    && value.externalActionPerformed === false
    && validTime(value.verifiedAt)
    && hashRecord('PackageRecoveryVerification', payload)
      === packageRecoveryVerificationHash);
}

function createReferenceSnapshot(referenceAuthority, scannedAt) {
  const payload = {
    version: 1,
    kind: 'PackageRetentionReferenceSnapshot',
    status: 'package_retention_reference_inventory_complete',
    inventoryComplete: true,
    campaignInventoryHash: referenceAuthority?.campaignInventoryHash,
    currentReleaseInventoryHash: referenceAuthority?.currentReleaseInventoryHash,
    casManifestInventoryHash: referenceAuthority?.casManifestInventoryHash,
    receiptLedgerInventoryHash: referenceAuthority?.receiptLedgerInventoryHash,
    activeReferenceCampaignIds: [...(referenceAuthority?.activeReferenceCampaignIds || [])].sort(),
    recoveryReferenceCampaignIds:
      [...(referenceAuthority?.recoveryReferenceCampaignIds || [])].sort(),
    legalHoldReceiptHashes: [...(referenceAuthority?.legalHoldReceiptHashes || [])].sort(),
    casReferenceManifestHashes:
      [...(referenceAuthority?.casReferenceManifestHashes || [])].sort(),
    scannedAt,
  };
  return Object.freeze({
    ...payload,
    packageRetentionReferenceSnapshotHash:
      hashRecord('PackageRetentionReferenceSnapshot', payload),
  });
}

function verifyReferenceSnapshot(value) {
  const { packageRetentionReferenceSnapshotHash = null, ...payload } = value || {};
  return Boolean(exactKeys(value, REFERENCE_KEYS)
    && value.version === 1
    && value.kind === 'PackageRetentionReferenceSnapshot'
    && value.status === 'package_retention_reference_inventory_complete'
    && value.inventoryComplete === true
    && [
      'campaignInventoryHash', 'currentReleaseInventoryHash',
      'casManifestInventoryHash', 'receiptLedgerInventoryHash',
    ].every((field) => validHash(value[field]))
    && [
      'activeReferenceCampaignIds', 'recoveryReferenceCampaignIds',
      'legalHoldReceiptHashes', 'casReferenceManifestHashes',
    ].every((field) => Array.isArray(value[field]) && value[field].length === 0)
    && validTime(value.scannedAt)
    && hashRecord('PackageRetentionReferenceSnapshot', payload)
      === packageRetentionReferenceSnapshotHash);
}

export function createPackageSupersessionReceipt({
  predecessorLifecycleReceipt,
  successorLifecycleReceipt,
  lineageKind,
  referenceAuthority,
  recordedAt,
} = {}) {
  const predecessor = verifyPackageLifecycleReceipt(predecessorLifecycleReceipt);
  const successor = verifyPackageLifecycleReceipt(successorLifecycleReceipt);
  if (!predecessor.valid || !successor.valid
    || predecessorLifecycleReceipt.runtimeRoot !== successorLifecycleReceipt.runtimeRoot
    || predecessorLifecycleReceipt.releaseIdentity.paperId
      !== successorLifecycleReceipt.releaseIdentity.paperId
    || predecessorLifecycleReceipt.packagePath === successorLifecycleReceipt.packagePath
    || predecessorLifecycleReceipt.packageContentHash
      === successorLifecycleReceipt.packageContentHash
    || predecessorLifecycleReceipt.releaseIdentity.campaignId
      === successorLifecycleReceipt.releaseIdentity.campaignId
    || !LINEAGE_KINDS.has(lineageKind)
    || Date.parse(successorLifecycleReceipt.releaseIdentity.promotedAt)
      < Date.parse(predecessorLifecycleReceipt.releaseIdentity.promotedAt)) {
    throw new Error('package_supersession_lineage_invalid');
  }
  const referenceSnapshot = createReferenceSnapshot(referenceAuthority, recordedAt);
  const payload = {
    version: 2,
    kind: 'PackageSupersessionReceipt',
    status: 'package_supersession_lineage_recorded',
    runtimeRoot: predecessorLifecycleReceipt.runtimeRoot,
    paperId: predecessorLifecycleReceipt.releaseIdentity.paperId,
    lineageKind,
    predecessorLifecycleReceiptHash:
      predecessorLifecycleReceipt.packageLifecycleReceiptHash,
    successorLifecycleReceiptHash: successorLifecycleReceipt.packageLifecycleReceiptHash,
    predecessorReleaseIdentityHash: predecessorLifecycleReceipt.packageReleaseIdentityHash,
    successorReleaseIdentityHash: successorLifecycleReceipt.packageReleaseIdentityHash,
    predecessorPackagePath: predecessorLifecycleReceipt.packagePath,
    predecessorPackageContentHash: predecessorLifecycleReceipt.packageContentHash,
    successorPackagePath: successorLifecycleReceipt.packagePath,
    successorPackageContentHash: successorLifecycleReceipt.packageContentHash,
    successorIsExactPredecessorCopy: false,
    successorAuthorizesPredecessorDeletion: false,
    referenceSnapshot,
    packageRetentionReferenceSnapshotHash:
      referenceSnapshot.packageRetentionReferenceSnapshotHash,
    recordedAt,
    externalActionPerformed: false,
  };
  const receipt = Object.freeze({
    ...payload,
    packageSupersessionReceiptHash: hashRecord('PackageSupersessionReceipt', payload),
  });
  if (!verifyPackageSupersessionReceipt(receipt, {
    predecessorLifecycleReceipt,
    successorLifecycleReceipt,
  }).valid) throw new Error('package_supersession_receipt_invalid');
  return receipt;
}

function lifecycleBindingValid(
  receipt,
  predecessorLifecycleReceipt,
  successorLifecycleReceipt,
  { strictTime = true } = {},
) {
  const predecessor = verifyPackageLifecycleReceipt(predecessorLifecycleReceipt || {});
  const successor = verifyPackageLifecycleReceipt(successorLifecycleReceipt || {});
  return predecessor.valid && successor.valid
    && receipt?.runtimeRoot === predecessorLifecycleReceipt.runtimeRoot
    && receipt?.runtimeRoot === successorLifecycleReceipt.runtimeRoot
    && receipt?.paperId === predecessorLifecycleReceipt.releaseIdentity.paperId
    && receipt?.paperId === successorLifecycleReceipt.releaseIdentity.paperId
    && receipt?.predecessorLifecycleReceiptHash
      === predecessorLifecycleReceipt.packageLifecycleReceiptHash
    && receipt?.successorLifecycleReceiptHash
      === successorLifecycleReceipt.packageLifecycleReceiptHash
    && receipt?.predecessorReleaseIdentityHash
      === predecessorLifecycleReceipt.packageReleaseIdentityHash
    && receipt?.successorReleaseIdentityHash
      === successorLifecycleReceipt.packageReleaseIdentityHash
    && receipt?.predecessorPackagePath === predecessorLifecycleReceipt.packagePath
    && receipt?.successorPackagePath === successorLifecycleReceipt.packagePath
    && receipt?.predecessorPackageContentHash
      === predecessorLifecycleReceipt.packageContentHash
    && receipt?.successorPackageContentHash === successorLifecycleReceipt.packageContentHash
    && (strictTime
      ? strictlyAfter(receipt?.recordedAt, predecessorLifecycleReceipt.recordedAt)
        && strictlyAfter(receipt?.recordedAt, successorLifecycleReceipt.recordedAt)
      : atOrAfter(receipt?.recordedAt, predecessorLifecycleReceipt.recordedAt)
        && atOrAfter(receipt?.recordedAt, successorLifecycleReceipt.recordedAt));
}

export function verifyLegacyPackageSupersessionReceipt(receipt, {
  predecessorLifecycleReceipt = null,
  successorLifecycleReceipt = null,
} = {}) {
  const blockers = [];
  const { packageSupersessionReceiptHash = null, ...payload } = receipt || {};
  if (!exactKeys(receipt, LEGACY_SUPERSESSION_KEYS)
    || receipt?.version !== 1
    || receipt.kind !== 'PackageSupersessionReceipt'
    || receipt.status !== 'package_supersession_recovery_verified'
    || !nonEmpty(receipt.runtimeRoot)
    || !nonEmpty(receipt.paperId)
    || !LINEAGE_KINDS.has(receipt.lineageKind)
    || !validHash(receipt.predecessorLifecycleReceiptHash)
    || !validHash(receipt.successorLifecycleReceiptHash)
    || !validHash(receipt.predecessorReleaseIdentityHash)
    || !validHash(receipt.successorReleaseIdentityHash)
    || !nonEmpty(receipt.predecessorPackagePath)
    || !nonEmpty(receipt.successorPackagePath)
    || !validHash(receipt.predecessorPackageContentHash)
    || !validHash(receipt.successorPackageContentHash)
    || receipt.predecessorLifecycleReceiptHash === receipt.successorLifecycleReceiptHash
    || receipt.predecessorPackagePath === receipt.successorPackagePath
    || receipt.predecessorPackageContentHash === receipt.successorPackageContentHash
    || receipt.packageRecoveryVerificationHash
      !== receipt.recoveryVerification?.packageRecoveryVerificationHash
    || !verifyLegacyRecoveryVerification(receipt.recoveryVerification)
    || receipt.recoveryVerification?.predecessorPackageContentHash
      !== receipt.predecessorPackageContentHash
    || receipt.recoveryVerification?.successorPackageContentHash
      !== receipt.successorPackageContentHash
    || receipt.recoveryVerification?.successorLifecycleReceiptHash
      !== receipt.successorLifecycleReceiptHash
    || receipt.recoveryVerification?.successorReleaseIdentityHash
      !== receipt.successorReleaseIdentityHash
    || receipt.packageRetentionReferenceSnapshotHash
      !== receipt.referenceSnapshot?.packageRetentionReferenceSnapshotHash
    || !verifyReferenceSnapshot(receipt.referenceSnapshot)
    || !validTime(receipt.recordedAt)
    || Date.parse(receipt.recoveryVerification?.verifiedAt || '')
      > Date.parse(receipt.recordedAt)
    || Date.parse(receipt.referenceSnapshot?.scannedAt || '')
      > Date.parse(receipt.recordedAt)
    || receipt.externalActionPerformed !== false
    || hashRecord('PackageSupersessionReceipt', payload)
      !== packageSupersessionReceiptHash) {
    blockers.push('package_supersession_legacy_receipt_invalid');
  }
  if (predecessorLifecycleReceipt || successorLifecycleReceipt) {
    if (!predecessorLifecycleReceipt || !successorLifecycleReceipt
      || !lifecycleBindingValid(
        receipt,
        predecessorLifecycleReceipt,
        successorLifecycleReceipt,
        { strictTime: false },
      )
      || !verifyLegacyRecoveryVerification(
        receipt?.recoveryVerification,
        predecessorLifecycleReceipt,
        successorLifecycleReceipt,
      )) {
      blockers.push('package_supersession_legacy_lifecycle_binding_invalid');
    }
  }
  return result(blockers, {
    version: 1,
    legacy: true,
    deletionAuthorized: false,
  });
}

export function verifyPackageSupersessionReceipt(receipt, {
  predecessorLifecycleReceipt = null,
  successorLifecycleReceipt = null,
} = {}) {
  if (receipt?.version === 1) {
    return verifyLegacyPackageSupersessionReceipt(receipt, {
      predecessorLifecycleReceipt,
      successorLifecycleReceipt,
    });
  }
  const blockers = [];
  const { packageSupersessionReceiptHash = null, ...payload } = receipt || {};
  if (!exactKeys(receipt, SUPERSESSION_KEYS)
    || receipt?.version !== 2
    || receipt.kind !== 'PackageSupersessionReceipt'
    || receipt.status !== 'package_supersession_lineage_recorded'
    || !nonEmpty(receipt.runtimeRoot)
    || !nonEmpty(receipt.paperId)
    || !LINEAGE_KINDS.has(receipt.lineageKind)
    || !validHash(receipt.predecessorLifecycleReceiptHash)
    || !validHash(receipt.successorLifecycleReceiptHash)
    || !validHash(receipt.predecessorReleaseIdentityHash)
    || !validHash(receipt.successorReleaseIdentityHash)
    || !canonicalAbsolutePath(receipt.predecessorPackagePath)
    || !canonicalAbsolutePath(receipt.successorPackagePath)
    || !validHash(receipt.predecessorPackageContentHash)
    || !validHash(receipt.successorPackageContentHash)
    || receipt.predecessorLifecycleReceiptHash === receipt.successorLifecycleReceiptHash
    || receipt.predecessorPackagePath === receipt.successorPackagePath
    || receipt.predecessorPackageContentHash === receipt.successorPackageContentHash
    || receipt.successorIsExactPredecessorCopy !== false
    || receipt.successorAuthorizesPredecessorDeletion !== false
    || receipt.packageRetentionReferenceSnapshotHash
      !== receipt.referenceSnapshot?.packageRetentionReferenceSnapshotHash
    || !verifyReferenceSnapshot(receipt.referenceSnapshot)
    || receipt.referenceSnapshot?.scannedAt !== receipt.recordedAt
    || !canonicalTime(receipt.recordedAt)
    || receipt.externalActionPerformed !== false
    || hashRecord('PackageSupersessionReceipt', payload)
      !== packageSupersessionReceiptHash) {
    blockers.push('package_supersession_receipt_invalid');
  }
  if (predecessorLifecycleReceipt || successorLifecycleReceipt) {
    if (!predecessorLifecycleReceipt || !successorLifecycleReceipt
      || !lifecycleBindingValid(
        receipt,
        predecessorLifecycleReceipt,
        successorLifecycleReceipt,
      )) {
      blockers.push('package_supersession_lifecycle_binding_invalid');
    }
  }
  return result(blockers, {
    version: 2,
    legacy: false,
    deletionAuthorized: false,
  });
}

export function createPackageRetentionLegalHoldReceipt({
  lifecycleReceipt,
  reasonHash,
  createdAt,
} = {}) {
  if (!verifyPackageLifecycleReceipt(lifecycleReceipt).valid) {
    throw new Error('package_legal_hold_lifecycle_invalid');
  }
  const payload = {
    version: 1,
    kind: 'PackageRetentionLegalHoldReceipt',
    status: 'package_retention_legal_hold_active',
    runtimeRoot: lifecycleReceipt.runtimeRoot,
    paperId: lifecycleReceipt.releaseIdentity.paperId,
    packagePath: lifecycleReceipt.packagePath,
    packageContentHash: lifecycleReceipt.packageContentHash,
    packageLifecycleReceiptHash: lifecycleReceipt.packageLifecycleReceiptHash,
    reasonHash,
    createdAt,
    externalActionPerformed: false,
  };
  const receipt = Object.freeze({
    ...payload,
    packageRetentionLegalHoldReceiptHash:
      hashRecord('PackageRetentionLegalHoldReceipt', payload),
  });
  if (!verifyPackageRetentionLegalHoldReceipt(receipt, { lifecycleReceipt }).valid) {
    throw new Error('package_legal_hold_receipt_invalid');
  }
  return receipt;
}

export function verifyPackageRetentionLegalHoldReceipt(receipt, {
  lifecycleReceipt = null,
} = {}) {
  const blockers = [];
  const { packageRetentionLegalHoldReceiptHash = null, ...payload } = receipt || {};
  if (!exactKeys(receipt, HOLD_KEYS)
    || receipt?.version !== 1
    || receipt.kind !== 'PackageRetentionLegalHoldReceipt'
    || receipt.status !== 'package_retention_legal_hold_active'
    || !nonEmpty(receipt.runtimeRoot)
    || !nonEmpty(receipt.paperId)
    || !nonEmpty(receipt.packagePath)
    || !validHash(receipt.packageContentHash)
    || !validHash(receipt.packageLifecycleReceiptHash)
    || !validHash(receipt.reasonHash)
    || !validTime(receipt.createdAt)
    || receipt.externalActionPerformed !== false
    || hashRecord('PackageRetentionLegalHoldReceipt', payload)
      !== packageRetentionLegalHoldReceiptHash) {
    blockers.push('package_legal_hold_receipt_invalid');
  }
  if (lifecycleReceipt && (receipt?.runtimeRoot !== lifecycleReceipt.runtimeRoot
    || receipt?.paperId !== lifecycleReceipt.releaseIdentity?.paperId
    || receipt?.packagePath !== lifecycleReceipt.packagePath
    || receipt?.packageContentHash !== lifecycleReceipt.packageContentHash
    || receipt?.packageLifecycleReceiptHash !== lifecycleReceipt.packageLifecycleReceiptHash
    || !atOrAfter(receipt?.createdAt, lifecycleReceipt.recordedAt))) {
    blockers.push('package_legal_hold_lifecycle_binding_invalid');
  }
  return result(blockers);
}
