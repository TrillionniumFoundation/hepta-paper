import { hasExactPlainObjectKeys }
  from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const MAX_RESPONSE_DELAY_MS = 30 * 1000;
const MAX_VALIDITY_MS = 5 * 60 * 1000;
const INSPECTION_KEYS = Object.freeze([
  'version', 'kind', 'status', 'challengeHash', 'requestedAt', 'checkedAt', 'expiresAt',
  'storageAuthorityAuthenticated', 'storageLedgerAuthorityAuthenticated',
  'retentionLockAuthorityAuthenticated', 'restoreAuthorityAuthenticated',
  'trustStoreVerified', 'deletionLeaseAuthorityAuthenticated',
  'storageAuthorityCanary', 'restoreAuthorityCanary',
  'deletionLeaseAuthorityCanary',
  'authoritySnapshotHash', 'deploymentIdentityHash', 'readinessTrustStoreHash',
  'authenticatedAuthorityAttestationHash', 'blockers',
  'packageRecoveryAuthorityReadinessInspectionHash',
]);
const STORAGE_CANARY_KEYS = Object.freeze(['proof', 'lifecycleReceipt']);
const RESTORE_CANARY_KEYS = Object.freeze(['proof', 'recoverySourceAuthority']);
const DELETION_LEASE_CANARY_KEYS = Object.freeze(['acquireRequest']);

function canonicalTime(value) {
  return typeof value === 'string'
    && Number.isFinite(Date.parse(value))
    && new Date(Date.parse(value)).toISOString() === value;
}

export function packageRecoveryAuthorityReadinessAttestationSubject(
  inspection = {},
) {
  return Object.freeze({
    version: 1,
    kind: 'PackageRecoveryReadinessAttestationSubject',
    challengeHash: inspection.challengeHash,
    requestedAt: inspection.requestedAt,
    checkedAt: inspection.checkedAt,
    expiresAt: inspection.expiresAt,
    storageAuthorityAuthenticated: inspection.storageAuthorityAuthenticated,
    storageLedgerAuthorityAuthenticated:
      inspection.storageLedgerAuthorityAuthenticated,
    retentionLockAuthorityAuthenticated:
      inspection.retentionLockAuthorityAuthenticated,
    restoreAuthorityAuthenticated: inspection.restoreAuthorityAuthenticated,
    trustStoreVerified: inspection.trustStoreVerified,
    deletionLeaseAuthorityAuthenticated:
      inspection.deletionLeaseAuthorityAuthenticated,
    storageAuthorityCanaryHash: hashRecord(
      'PackageRecoveryReadinessStorageAuthorityCanary',
      inspection.storageAuthorityCanary,
    ),
    restoreAuthorityCanaryHash: hashRecord(
      'PackageRecoveryReadinessRestoreAuthorityCanary',
      inspection.restoreAuthorityCanary,
    ),
    deletionLeaseAuthorityCanaryHash: hashRecord(
      'PackageRecoveryReadinessDeletionLeaseAuthorityCanary',
      inspection.deletionLeaseAuthorityCanary,
    ),
    authoritySnapshotHash: inspection.authoritySnapshotHash,
    deploymentIdentityHash: inspection.deploymentIdentityHash,
    readinessTrustStoreHash: inspection.readinessTrustStoreHash,
  });
}

export function createPackageRecoveryAuthorityReadinessInspection({
  challengeHash,
  requestedAt,
  checkedAt,
  expiresAt,
  storageAuthorityCanary,
  restoreAuthorityCanary,
  deletionLeaseAuthorityCanary,
  authoritySnapshotHash,
  deploymentIdentityHash,
  readinessTrustStoreHash,
  authenticatedAuthorityAttestationHash,
} = {}) {
  const payload = {
    version: 1,
    kind: 'PackageRecoveryAuthorityReadinessInspection',
    status: 'package_recovery_authority_ready',
    challengeHash,
    requestedAt,
    checkedAt,
    expiresAt,
    storageAuthorityAuthenticated: true,
    storageLedgerAuthorityAuthenticated: true,
    retentionLockAuthorityAuthenticated: true,
    restoreAuthorityAuthenticated: true,
    trustStoreVerified: true,
    deletionLeaseAuthorityAuthenticated: true,
    storageAuthorityCanary: Object.freeze({ ...(storageAuthorityCanary || {}) }),
    restoreAuthorityCanary: Object.freeze({ ...(restoreAuthorityCanary || {}) }),
    deletionLeaseAuthorityCanary: Object.freeze({
      ...(deletionLeaseAuthorityCanary || {}),
    }),
    authoritySnapshotHash,
    deploymentIdentityHash,
    readinessTrustStoreHash,
    authenticatedAuthorityAttestationHash,
    blockers: Object.freeze([]),
  };
  return Object.freeze({
    ...payload,
    packageRecoveryAuthorityReadinessInspectionHash: hashRecord(
      'PackageRecoveryAuthorityReadinessInspection',
      payload,
    ),
  });
}

export function verifyPackageRecoveryAuthorityReadinessInspection(
  inspection,
  { challengeHash, requestedAt, observedAt } = {},
) {
  const {
    packageRecoveryAuthorityReadinessInspectionHash = null,
    ...payload
  } = inspection || {};
  const requestedMs = Date.parse(requestedAt || '');
  const observedMs = Date.parse(observedAt || '');
  const checkedMs = Date.parse(inspection?.checkedAt || '');
  const expiresMs = Date.parse(inspection?.expiresAt || '');
  return Boolean(hasExactPlainObjectKeys(inspection, INSPECTION_KEYS)
    && inspection.version === 1
    && inspection.kind === 'PackageRecoveryAuthorityReadinessInspection'
    && inspection.status === 'package_recovery_authority_ready'
    && inspection.challengeHash === challengeHash
    && inspection.requestedAt === requestedAt
    && [requestedAt, observedAt, inspection.requestedAt,
      inspection.checkedAt, inspection.expiresAt]
      .every(canonicalTime)
    && observedMs >= requestedMs
    && observedMs - requestedMs <= MAX_RESPONSE_DELAY_MS
    && observedMs <= expiresMs
    && checkedMs >= requestedMs
    && checkedMs <= observedMs
    && checkedMs - requestedMs <= MAX_RESPONSE_DELAY_MS
    && expiresMs > checkedMs
    && expiresMs - requestedMs <= MAX_VALIDITY_MS
    && inspection.storageAuthorityAuthenticated === true
    && inspection.storageLedgerAuthorityAuthenticated === true
    && inspection.retentionLockAuthorityAuthenticated === true
    && inspection.restoreAuthorityAuthenticated === true
    && inspection.trustStoreVerified === true
    && inspection.deletionLeaseAuthorityAuthenticated === true
    && hasExactPlainObjectKeys(inspection.storageAuthorityCanary, STORAGE_CANARY_KEYS)
    && hasExactPlainObjectKeys(inspection.restoreAuthorityCanary, RESTORE_CANARY_KEYS)
    && hasExactPlainObjectKeys(
      inspection.deletionLeaseAuthorityCanary,
      DELETION_LEASE_CANARY_KEYS,
    )
    && [
      inspection.authoritySnapshotHash,
      inspection.deploymentIdentityHash,
      inspection.readinessTrustStoreHash,
      inspection.authenticatedAuthorityAttestationHash,
    ].every((value) => SHA256.test(String(value || '')))
    && Array.isArray(inspection.blockers)
    && inspection.blockers.length === 0
    && hashRecord('PackageRecoveryAuthorityReadinessInspection', payload)
      === packageRecoveryAuthorityReadinessInspectionHash);
}
