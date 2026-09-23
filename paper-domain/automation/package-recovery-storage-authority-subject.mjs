import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function packageRecoveryStorageAuthoritySubject(proof = {}) {
  return Object.freeze({
    version: 2,
    kind: 'PackageRecoveryStorageAuthoritySubject',
    lifecycleAuthority: Object.freeze({
      runtimeRoot: proof.runtimeRoot,
      paperId: proof.paperId,
      packagePath: proof.packagePath,
      packageContentHash: proof.packageContentHash,
      packageLifecycleReceiptHash: proof.packageLifecycleReceiptHash,
      packageReleaseIdentityHash: proof.packageReleaseIdentityHash,
      immutableCampaignPackageOutputHash: proof.immutableCampaignPackageOutputHash,
      packageRecoveryTreeInventoryHash: proof.packageRecoveryTreeInventoryHash,
      lifecycleRecordedAt: proof.lifecycleRecordedAt,
    }),
    archiveAuthority: Object.freeze({
      schemaVersion: proof.archiveSchemaVersion,
      inventoryHash: proof.archiveInventoryHash,
    }),
    storageAuthorityId: proof.storageAuthorityId,
    storageClass: proof.storageClass,
    storageObjectId: proof.storageObjectId,
    storageObjectVersion: proof.storageObjectVersion,
    storageObjectPath: proof.storageObjectPath,
    storageObjectBytesHash: proof.storageObjectBytesHash,
    storedPackageContentHash: proof.storedPackageContentHash,
    sourceInventoryHash: proof.sourceInventoryHash,
    retentionPolicy: proof.retentionPolicy,
    packageRecoveryRetentionPolicyHash: proof.packageRecoveryRetentionPolicyHash,
    trustStoreHash: proof.trustStoreHash,
    ledgerAuthority: Object.freeze({
      receiptId: proof.ledgerIdentity?.receiptId,
      receiptHash: proof.ledgerIdentity?.receiptHash,
      stream: proof.ledgerIdentity?.stream,
      writerId: proof.ledgerIdentity?.writerId,
      writerKind: proof.ledgerIdentity?.writerKind,
      issuerPolicyId: proof.ledgerIdentity?.issuerPolicyId,
      issuerPolicyHash: proof.ledgerIdentity?.issuerPolicyHash,
      writerTrusted: proof.ledgerIdentity?.writerTrusted,
    }),
    issuedAt: proof.issuedAt,
    verifiedAt: proof.verifiedAt,
    verificationEpoch: proof.verificationEpoch,
  });
}

export function packageRecoveryStorageAuthoritySubjectHash(value = {}) {
  return hashRecord(
    'PackageRecoveryStorageAuthoritySubject',
    packageRecoveryStorageAuthoritySubject(value),
  );
}
