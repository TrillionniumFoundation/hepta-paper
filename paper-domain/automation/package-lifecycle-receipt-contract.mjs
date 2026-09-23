import { hasExactPlainObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[a-f0-9]{64}$/;

const RELEASE_KEYS = Object.freeze([
  'version', 'kind', 'status', 'campaignId', 'paperId', 'campaignPlanHash',
  'packageNodeId', 'packageResultHash', 'campaignReleaseBundleHash',
  'materializationReceiptHash', 'packagePath', 'immutableCampaignPackageOutputHash',
  'packageNodeStatus', 'campaignStatus', 'promotedAt', 'packageReleaseIdentityHash',
]);

const LEGACY_LIFECYCLE_KEYS = Object.freeze([
  'version', 'kind', 'status', 'runtimeRoot', 'packagePath', 'packageContentHash',
  'immutableAtRecord', 'releaseIdentity', 'packageReleaseIdentityHash',
  'recordedAt', 'externalActionPerformed', 'packageLifecycleReceiptHash',
]);

const LIFECYCLE_KEYS = Object.freeze([
  ...LEGACY_LIFECYCLE_KEYS,
  'packageRecoveryTreeInventoryHash',
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

function atOrAfter(value, lowerBound) {
  return validTime(value) && validTime(lowerBound)
    && Date.parse(value) >= Date.parse(lowerBound);
}

function exactKeys(value, keys) {
  return hasExactPlainObjectKeys(value, [...keys].sort());
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
  if (!exactKeys(identity, RELEASE_KEYS)
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
  return Object.freeze({
    valid: blockers.length === 0,
    blockers: Object.freeze([...new Set(blockers)]),
  });
}

export function createPackageLifecycleReceipt({
  runtimeRoot,
  packagePath,
  packageContentHash,
  packageRecoveryTreeInventoryHash,
  release,
  recordedAt,
} = {}) {
  const releaseIdentity = createPackageReleaseIdentity(release);
  const payload = {
    version: 2,
    kind: 'PackageLifecycleReceipt',
    status: 'package_lifecycle_current_release_recorded',
    runtimeRoot,
    packagePath,
    packageContentHash,
    packageRecoveryTreeInventoryHash,
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
  const legacy = receipt?.version === 1;
  const keys = legacy ? LEGACY_LIFECYCLE_KEYS : LIFECYCLE_KEYS;
  if (!exactKeys(receipt, keys)
    || ![1, 2].includes(receipt?.version)
    || receipt.kind !== 'PackageLifecycleReceipt'
    || receipt.status !== 'package_lifecycle_current_release_recorded'
    || !nonEmpty(receipt.runtimeRoot)
    || !nonEmpty(receipt.packagePath)
    || !validHash(receipt.packageContentHash)
    || (!legacy && !validHash(receipt.packageRecoveryTreeInventoryHash))
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
  return Object.freeze({
    valid: blockers.length === 0,
    version: legacy ? 1 : 2,
    legacy,
    recoveryInventoryBound: !legacy && blockers.length === 0,
    deletionAuthorized: false,
    blockers: Object.freeze([...new Set(blockers)]),
  });
}
