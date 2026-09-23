const SHA256 = /^sha256:[0-9a-f]{64}$/;

export function assertAutonomousSubmissionPortalPort(value, {
  requiredLocalOriginIdentitySubjectHashes = [],
} = {}) {
  if (!value || value.kind !== 'AutonomousSubmissionPortalPort'
    || typeof value.submit !== 'function'
    || typeof value.lookup !== 'function'
    || value.idempotencyLookupSupported !== true
    || value.singleUseDispatchCapabilityEnforced !== true
    || ![true, false].includes(value.authoritativeLookupCapabilityIssued)
    || ![true, false].includes(value.signedCompletedReceiptSupported)
    || ![true, false].includes(value.cryptographicAuthorityReady)
    || ![true, false].includes(value.identityIndependenceReady)
    || (value.signedCompletedReceiptSupported === true
      && (value.completedReceiptVerifier?.kind
        !== 'AutonomousSubmissionCompletedReceiptVerifier'
        || typeof value.completedReceiptVerifier.verify !== 'function'
        || value.completedReceiptVerifier.cryptographicAuthorityReady !== true))
    || (value.authoritativeLookupCapabilityIssued === true
      && (value.signedAuthoritativeLookupSupported !== true
        || value.authoritativeNotFoundCryptographicAuthorityReady !== true))
    || (value.cryptographicAuthorityReady === true
      && value.signedCompletedReceiptSupported !== true)
    || (value.identityIndependenceReady === true
      && (value.cryptographicAuthorityReady !== true
        || !value.trustSetHash || !value.signatureVerificationPolicyHash))
    || !value.configurationHash) {
    throw new Error('autonomous_submission_portal_port_invalid');
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
    throw new Error('autonomous_submission_portal_required_origin_identity_missing');
  }
  return value;
}
