const SHA256 = /^sha256:[0-9a-f]{64}$/;

export function assertExternalResearchReplayPort(value, {
  expectedConfigurationHash = null,
  requiredLocalOriginIdentitySubjectHashes = [],
} = {}) {
  if (!value || value.kind !== 'ExternalResearchReplayPort'
    || typeof value.replay !== 'function'
    || ![true, false].includes(value.cryptographicAuthorityReady)
    || ![true, false].includes(value.identityIndependenceReady)
    || (value.identityIndependenceReady === true
      && (value.cryptographicAuthorityReady !== true
        || typeof value.verifyReceipt !== 'function'
        || !SHA256.test(String(value.trustSetHash || ''))
        || !SHA256.test(String(value.signatureVerificationPolicyHash || ''))))) {
    throw new Error('external_research_replay_port_invalid');
  }
  if (expectedConfigurationHash
    && value.configurationHash !== expectedConfigurationHash) {
    throw new Error('external_research_replay_configuration_binding_invalid');
  }
  const requiredOriginHashes = [...new Set(
    (Array.isArray(requiredLocalOriginIdentitySubjectHashes)
      ? requiredLocalOriginIdentitySubjectHashes : [])
      .map((hash) => String(hash || '').toLowerCase()),
  )].sort();
  const observedOriginHashes = value.identitySeparationInspection
    ?.localOriginIdentitySubjects?.map((subject) => (
      subject?.externalPrincipalIdentityAttestationSubjectHash || null
    )).filter(Boolean) || [];
  if (requiredOriginHashes.some((hash) => !SHA256.test(hash))
    || requiredOriginHashes.some((hash) => !observedOriginHashes.includes(hash))) {
    throw new Error('external_research_replay_required_origin_identity_missing');
  }
  return value;
}
