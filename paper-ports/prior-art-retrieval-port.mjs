const SHA256 = /^sha256:[0-9a-f]{64}$/;

export function assertPriorArtRetrievalPort(value, {
  expectedConfigurationHash = null,
} = {}) {
  if (!value || value.kind !== 'PriorArtRetrievalPort'
    || typeof value.retrieve !== 'function'
    || ![true, false].includes(value.configurationPinned)
    || ![true, false].includes(value.fullProductionReady)
    || ![true, false].includes(value.cryptographicAuthorityReady)
    || ![true, false].includes(value.identityIndependenceReady)
    || (value.identityIndependenceReady === true
      && value.cryptographicAuthorityReady !== true)
    || (value.cryptographicAuthorityReady === true
      && (value.evidenceProfile !== 'structured-ranked-deduplicated-v2'
        || !SHA256.test(String(value.trustSetHash || ''))
        || !SHA256.test(String(value.signatureVerificationPolicyHash || ''))
        || !SHA256.test(String(value.authorityTrustConfigurationHash || ''))
        || typeof value.authorityFor !== 'function'
        || typeof value.verifyAuthority !== 'function'
        || typeof value.verifyAuthorityBundle !== 'function'
        || typeof value.authorityTrustConfiguration !== 'function'))
    || (value.fullProductionReady === true
      && (value.configurationPinned !== true
        || value.cryptographicAuthorityReady !== true
        || value.identityIndependenceReady !== true))) {
    throw new Error('prior_art_retrieval_port_invalid');
  }
  if (expectedConfigurationHash
    && value.configurationHash !== expectedConfigurationHash) {
    throw new Error('prior_art_retrieval_configuration_binding_invalid');
  }
  return value;
}
