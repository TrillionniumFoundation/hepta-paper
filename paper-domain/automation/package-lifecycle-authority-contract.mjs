import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const LINEAGE_KINDS = new Set(['supersedes', 'recovery']);

const RELEASE_KEYS = Object.freeze([
  'version', 'kind', 'status', 'campaignId', 'paperId', 'campaignPlanHash',
  'packageNodeId', 'packageResultHash', 'campaignReleaseBundleHash',
  'materializationReceiptHash', 'packagePath', 'immutableCampaignPackageOutputHash',
  'packageNodeStatus', 'campaignStatus', 'promotedAt', 'packageReleaseIdentityHash',
]);

const LIFECYCLE_KEYS = Object.freeze([
  'version', 'kind', 'status', 'runtimeRoot', 'packagePath', 'packageContentHash',
  'immutableAtRecord', 'releaseIdentity', 'packageReleaseIdentityHash',
  'recordedAt', 'externalActionPerformed', 'packageLifecycleReceiptHash',
]);

const RECOVERY_KEYS = Object.freeze([
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
  return SHA256.test(String(value || ''));
}

function validTime(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function atOrAfter(value, lowerBound) {
  return validTime(value) && validTime(lowerBound)
    && Date.parse(value) >= Date.parse(lowerBound);
}

function packagePathFromRelease(release) {
  return release?.packagePath
    || release?.releaseBundle?.packageOutput?.packageDir
    || null;
}

function packageOutputHashFromRelease(release) {
  return release?.immutableCampaignPackageOutputHash
    || release?.releaseBundle?.immutableCampaignPackageOutputHash
    || release?.releaseBundle?.packageOutput?.immutableCampaignPackageOutputHash
    || null;
}

export function createPackageReleaseIdentity(release = {}) {
  const payload = {
    version: 1,
    kind: 'PackageReleaseIdentity',
    status: release.status,
    campaignId: release.campaignId,
    paperId: release.paperId,
    campaignPlanHash: release.campaignPlanHash,
    packageNodeId: release.packageNodeId,
    packageResultHash: release.packageResultHash,
    campaignReleaseBundleHash: release.campaignReleaseBundleHash,
    materializationReceiptHash: release.materializationReceiptHash,
    packagePath: packagePathFromRelease(release),
    immutableCampaignPackageOutputHash: packageOutputHashFromRelease(release),
    packageNodeStatus: release.packageNodeStatus,
    campaignStatus: release.campaignStatus,
    promotedAt: release.promotedAt,
  };
  const identity = Object.freeze({
    ...payload,
    packageReleaseIdentityHash: hashRecord('PackageReleaseIdentity', payload),
  });
  if (!verifyPackageReleaseIdentity(identity).valid) {
    throw new Error('package_release_identity_invalid');
  }
  return identity;
}

export function verifyPackageReleaseIdentity(identity, expected = {}) {
  const blockers = [];
  const { packageReleaseIdentityHash = null, ...payload } = identity || {};
  if (!hasExactObjectKeys(identity, RELEASE_KEYS)
    || identity?.version !== 1
    || identity.kind !== 'PackageReleaseIdentity'
    || identity.status !== 'current_completed_release'
    || identity.packageNodeStatus !== 'completed'
    || identity.campaignStatus !== 'completed'
    || !nonEmpty(identity.campaignId)
    || !nonEmpty(identity.paperId)
    || !nonEmpty(identity.packageNodeId)
    || !nonEmpty(identity.packagePath)
    || !validHash(identity.campaignPlanHash)
    || !validHash(identity.packageResultHash)
    || !validHash(identity.campaignReleaseBundleHash)
    || !validHash(identity.materializationReceiptHash)
    || !validHash(identity.immutableCampaignPackageOutputHash)
    || !validTime(identity.promotedAt)
    || hashRecord('PackageReleaseIdentity', payload) !== packageReleaseIdentityHash) {
    blockers.push('package_release_identity_invalid');
  }
  for (const [field, value] of Object.entries(expected)) {
    if (value !== undefined && identity?.[field] !== value) {
      blockers.push(`package_release_identity_${field}_mismatch`);
    }
  }
  return Object.freeze({ valid: blockers.length === 0, blockers: Object.freeze([...new Set(blockers)]) });
}

export function createPackageLifecycleReceipt({
  runtimeRoot,
  packagePath,
  packageContentHash,
  release,
  recordedAt,
} = {}) {
  const releaseIdentity = createPackageReleaseIdentity(release);
  const payload = {
    version: 1,
    kind: 'PackageLifecycleReceipt',
    status: 'package_lifecycle_current_release_recorded',
    runtimeRoot,
    packagePath,
    packageContentHash,
    immutableAtRecord: true,
    releaseIdentity,
    packageReleaseIdentityHash: releaseIdentity.packageReleaseIdentityHash,
    recordedAt,
    externalActionPerformed: false,
  };
  const receipt = Object.freeze({
    ...payload,
    packageLifecycleReceiptHash: hashRecord('PackageLifecycleReceipt', payload),
  });
  if (!verifyPackageLifecycleReceipt(receipt).valid) {
    throw new Error('package_lifecycle_receipt_invalid');
  }
  return receipt;
}

export function verifyPackageLifecycleReceipt(receipt, expected = {}) {
  const blockers = [];
  const { packageLifecycleReceiptHash = null, ...payload } = receipt || {};
  const release = verifyPackageReleaseIdentity(receipt?.releaseIdentity || {});
  if (!hasExactObjectKeys(receipt, LIFECYCLE_KEYS)
    || receipt?.version !== 1
    || receipt.kind !== 'PackageLifecycleReceipt'
    || receipt.status !== 'package_lifecycle_current_release_recorded'
    || !nonEmpty(receipt.runtimeRoot)
    || !nonEmpty(receipt.packagePath)
    || !validHash(receipt.packageContentHash)
    || receipt.immutableAtRecord !== true
    || !release.valid
    || receipt.packageReleaseIdentityHash
      !== receipt.releaseIdentity?.packageReleaseIdentityHash
    || receipt.packagePath !== receipt.releaseIdentity?.packagePath
    || !atOrAfter(receipt.recordedAt, receipt.releaseIdentity?.promotedAt)
    || receipt.externalActionPerformed !== false
    || hashRecord('PackageLifecycleReceipt', payload) !== packageLifecycleReceiptHash) {
    blockers.push('package_lifecycle_receipt_invalid', ...release.blockers);
  }
  for (const [field, value] of Object.entries(expected)) {
    if (value !== undefined && receipt?.[field] !== value) {
      blockers.push(`package_lifecycle_${field}_mismatch`);
    }
  }
  return Object.freeze({ valid: blockers.length === 0, blockers: Object.freeze([...new Set(blockers)]) });
}

function createRecoveryVerification({ predecessor, successor, verifiedAt }) {
  const payload = {
    version: 1,
    kind: 'PackageRecoveryVerification',
    status: 'successor_package_recovery_verified',
    recoveryMode: 'current_successor_package_materialization',
    predecessorPackageContentHash: predecessor.packageContentHash,
    successorPackageContentHash: successor.packageContentHash,
    successorLifecycleReceiptHash: successor.packageLifecycleReceiptHash,
    successorReleaseIdentityHash: successor.packageReleaseIdentityHash,
    successorPackagePresent: true,
    successorPackageHashVerified: true,
    successorReleaseCurrent: true,
    restoreSourceAvailable: true,
    productionPackageMutated: false,
    externalActionPerformed: false,
    verifiedAt,
  };
  return Object.freeze({
    ...payload,
    packageRecoveryVerificationHash: hashRecord('PackageRecoveryVerification', payload),
  });
}

function verifyRecoveryVerification(value, predecessor, successor) {
  const { packageRecoveryVerificationHash = null, ...payload } = value || {};
  return Boolean(hasExactObjectKeys(value, RECOVERY_KEYS)
    && value.version === 1
    && value.kind === 'PackageRecoveryVerification'
    && value.status === 'successor_package_recovery_verified'
    && value.recoveryMode === 'current_successor_package_materialization'
    && value.predecessorPackageContentHash === predecessor?.packageContentHash
    && value.successorPackageContentHash === successor?.packageContentHash
    && value.successorLifecycleReceiptHash === successor?.packageLifecycleReceiptHash
    && value.successorReleaseIdentityHash === successor?.packageReleaseIdentityHash
    && value.successorPackagePresent === true
    && value.successorPackageHashVerified === true
    && value.successorReleaseCurrent === true
    && value.restoreSourceAvailable === true
    && value.productionPackageMutated === false
    && value.externalActionPerformed === false
    && validTime(value.verifiedAt)
    && hashRecord('PackageRecoveryVerification', payload) === packageRecoveryVerificationHash);
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
    recoveryReferenceCampaignIds: [...(referenceAuthority?.recoveryReferenceCampaignIds || [])].sort(),
    legalHoldReceiptHashes: [...(referenceAuthority?.legalHoldReceiptHashes || [])].sort(),
    casReferenceManifestHashes: [...(referenceAuthority?.casReferenceManifestHashes || [])].sort(),
    scannedAt,
  };
  return Object.freeze({
    ...payload,
    packageRetentionReferenceSnapshotHash: hashRecord('PackageRetentionReferenceSnapshot', payload),
  });
}

function verifyReferenceSnapshot(value) {
  const { packageRetentionReferenceSnapshotHash = null, ...payload } = value || {};
  return Boolean(hasExactObjectKeys(value, REFERENCE_KEYS)
    && value.version === 1
    && value.kind === 'PackageRetentionReferenceSnapshot'
    && value.status === 'package_retention_reference_inventory_complete'
    && value.inventoryComplete === true
    && ['campaignInventoryHash', 'currentReleaseInventoryHash', 'casManifestInventoryHash', 'receiptLedgerInventoryHash']
      .every((field) => validHash(value[field]))
    && ['activeReferenceCampaignIds', 'recoveryReferenceCampaignIds', 'legalHoldReceiptHashes', 'casReferenceManifestHashes']
      .every((field) => Array.isArray(value[field]) && value[field].length === 0)
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
  const recoveryVerification = createRecoveryVerification({
    predecessor: predecessorLifecycleReceipt,
    successor: successorLifecycleReceipt,
    verifiedAt: recordedAt,
  });
  const referenceSnapshot = createReferenceSnapshot(referenceAuthority, recordedAt);
  const payload = {
    version: 1,
    kind: 'PackageSupersessionReceipt',
    status: 'package_supersession_recovery_verified',
    runtimeRoot: predecessorLifecycleReceipt.runtimeRoot,
    paperId: predecessorLifecycleReceipt.releaseIdentity.paperId,
    lineageKind,
    predecessorLifecycleReceiptHash: predecessorLifecycleReceipt.packageLifecycleReceiptHash,
    successorLifecycleReceiptHash: successorLifecycleReceipt.packageLifecycleReceiptHash,
    predecessorReleaseIdentityHash: predecessorLifecycleReceipt.packageReleaseIdentityHash,
    successorReleaseIdentityHash: successorLifecycleReceipt.packageReleaseIdentityHash,
    predecessorPackagePath: predecessorLifecycleReceipt.packagePath,
    predecessorPackageContentHash: predecessorLifecycleReceipt.packageContentHash,
    successorPackagePath: successorLifecycleReceipt.packagePath,
    successorPackageContentHash: successorLifecycleReceipt.packageContentHash,
    recoveryVerification,
    packageRecoveryVerificationHash: recoveryVerification.packageRecoveryVerificationHash,
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

export function verifyPackageSupersessionReceipt(receipt, {
  predecessorLifecycleReceipt = null,
  successorLifecycleReceipt = null,
} = {}) {
  const blockers = [];
  const { packageSupersessionReceiptHash = null, ...payload } = receipt || {};
  if (!hasExactObjectKeys(receipt, SUPERSESSION_KEYS)
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
    || receipt.packageRecoveryVerificationHash
      !== receipt.recoveryVerification?.packageRecoveryVerificationHash
    || receipt.packageRetentionReferenceSnapshotHash
      !== receipt.referenceSnapshot?.packageRetentionReferenceSnapshotHash
    || !verifyReferenceSnapshot(receipt.referenceSnapshot)
    || !validTime(receipt.recordedAt)
    || receipt.externalActionPerformed !== false
    || hashRecord('PackageSupersessionReceipt', payload)
      !== packageSupersessionReceiptHash) {
    blockers.push('package_supersession_receipt_invalid');
  }
  if (predecessorLifecycleReceipt || successorLifecycleReceipt) {
    const predecessor = verifyPackageLifecycleReceipt(predecessorLifecycleReceipt || {});
    const successor = verifyPackageLifecycleReceipt(successorLifecycleReceipt || {});
    if (!predecessor.valid || !successor.valid
      || receipt?.runtimeRoot !== predecessorLifecycleReceipt?.runtimeRoot
      || receipt?.runtimeRoot !== successorLifecycleReceipt?.runtimeRoot
      || receipt?.paperId !== predecessorLifecycleReceipt?.releaseIdentity?.paperId
      || receipt?.paperId !== successorLifecycleReceipt?.releaseIdentity?.paperId
      || receipt?.predecessorLifecycleReceiptHash
        !== predecessorLifecycleReceipt?.packageLifecycleReceiptHash
      || receipt?.successorLifecycleReceiptHash
        !== successorLifecycleReceipt?.packageLifecycleReceiptHash
      || receipt?.predecessorReleaseIdentityHash
        !== predecessorLifecycleReceipt?.packageReleaseIdentityHash
      || receipt?.successorReleaseIdentityHash
        !== successorLifecycleReceipt?.packageReleaseIdentityHash
      || receipt?.predecessorPackagePath !== predecessorLifecycleReceipt?.packagePath
      || receipt?.successorPackagePath !== successorLifecycleReceipt?.packagePath
      || receipt?.predecessorPackageContentHash
        !== predecessorLifecycleReceipt?.packageContentHash
      || receipt?.successorPackageContentHash !== successorLifecycleReceipt?.packageContentHash
      || !verifyRecoveryVerification(
        receipt?.recoveryVerification,
        predecessorLifecycleReceipt,
        successorLifecycleReceipt,
      )
      || !atOrAfter(receipt?.recordedAt, predecessorLifecycleReceipt?.recordedAt)
      || !atOrAfter(receipt?.recordedAt, successorLifecycleReceipt?.recordedAt)) {
      blockers.push('package_supersession_lifecycle_binding_invalid');
    }
  }
  return Object.freeze({ valid: blockers.length === 0, blockers: Object.freeze([...new Set(blockers)]) });
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

export function verifyPackageRetentionLegalHoldReceipt(receipt, { lifecycleReceipt = null } = {}) {
  const blockers = [];
  const { packageRetentionLegalHoldReceiptHash = null, ...payload } = receipt || {};
  if (!hasExactObjectKeys(receipt, HOLD_KEYS)
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
      !== packageRetentionLegalHoldReceiptHash) blockers.push('package_legal_hold_receipt_invalid');
  if (lifecycleReceipt && (receipt?.runtimeRoot !== lifecycleReceipt.runtimeRoot
    || receipt?.paperId !== lifecycleReceipt.releaseIdentity?.paperId
    || receipt?.packagePath !== lifecycleReceipt.packagePath
    || receipt?.packageContentHash !== lifecycleReceipt.packageContentHash
    || receipt?.packageLifecycleReceiptHash !== lifecycleReceipt.packageLifecycleReceiptHash
    || !atOrAfter(receipt?.createdAt, lifecycleReceipt.recordedAt))) {
    blockers.push('package_legal_hold_lifecycle_binding_invalid');
  }
  return Object.freeze({ valid: blockers.length === 0, blockers: Object.freeze([...new Set(blockers)]) });
}
