function keys(value) {
  return Object.freeze(value.trim().split(/\s+/).sort());
}

export const GENESIS_ENVELOPE_KEYS = keys(`authorityGeneration configurationHash expiresAt
  kind nonce ownerTrustStoreHash producerProfileHash signatures signedAt status validFrom version`);
export const GENESIS_PAYLOAD_KEYS = keys(`authorityGeneration configurationHash createdAt
  externalGenesisEnvelopeHash kind origin ownerTrustStoreHash producerProfileHash version`);
export const SIGNATURE_KEYS = keys('algorithm keyId role value');
export const TRUST_STORE_KEYS = keys('keys kind version');
export const TRUST_KEY_KEYS = keys(`algorithm effectiveFrom expiresAt keyId organization
  publicKeyPem revokedAt roles status subjectId`);
export const BOOTSTRAP_KEYS = keys(`expectedAuthorityGeneration expiresAt kind nonce
  ownerTrustStoreHash previousConfigurationHash rotationTrustStoreHash rotatorKeyIds
  rotatorKeySnapshotHash signatures signedAt status validFrom version`);
export const INTENT_KEYS = keys(`authorityAnchorHash authorityTrustStoreHash bootstrapReceiptHash
  expectedAuthorityGeneration expiresAt kind nextAuthorityGeneration nextConfigurationHash
  nextImplementationSha256 nextProducerProfileHash nextProviderConfigurationHash nonce planHash
  postStateHash preStateHash previousConfigurationHash previousProducerProfileHash
  previousRotationReceiptHash quiescenceStateHash rotatorKeySnapshotHash signatures signedAt
  status transition validFrom version`);
export const PLAN_KEYS = keys(`activeMachineLeases activeSupervisorLeases activeTopicLeases
  authorityAnchorHash authorityTrustStoreHash bootstrapReceiptHash datasetRoot
  expectedAuthorityGeneration identityConflicts kind nextAuthorityGeneration
  nextConfigurationHash nextImplementationSha256 nextProducerProfileHash
  nextProviderConfigurationHash outstandingTopicGenerations ownerTrustStoreHash planHash
  postStateHash preStateHash previousConfigurationHash previousProducerProfileHash
  previousRotationReceiptHash quarantinedLegacyMachineIntakeIds quiescenceStateHash
  rotatorKeySnapshotHash targetSourceIdentities topicProducerDatabasePresent transition version`);
export const RECEIPT_KEYS = keys(`authorityAnchorHash authorityGeneration authorityTrustStoreHash
  bootstrapReceipt bootstrapReceiptHash bootstrapVerifiedSignerIdentities datasetRoot
  externalActionPerformed kind nextConfigurationHash nextImplementationSha256
  nextProducerProfileHash nextProviderConfigurationHash ownerTrustStoreHash
  ownerTrustStoreSnapshot plan planHash postStateHash preStateHash previousConfigurationHash
  previousProducerProfileHash previousRotationReceiptHash quarantinedLegacyMachineAdmissionCount
  quiescenceStateHash rotatedAt rotationIntentHash rotationIntentNonce rotationReceiptHash
  rotationTrustStoreSnapshot rotatorKeySnapshotHash rotatorPublicKeySnapshot status transition
  verifiedSignerIdentity version`);

export function exactEvidenceKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expected);
}
